/**
 * ST-ImagePlus — Paster / Compresser / Downloader
 * ------------------------------------------------------------------
 * Three things a chat image needs, in one frontend extension:
 *
 * 1. **Paster** — paste or drop an image straight into the *message edit* box
 *    (the pencil / `.mes_edit` button), exactly like pasting into the
 *    unsent-message box (`#send_textarea`) already works.
 * 2. **Compresser** — optional: re-encode oversized images before upload so they
 *    fit a size budget, without touching images that already fit.
 * 3. **Downloader** — save an image (or a generated video) back out of the app:
 *    a corner control inside the chat lightbox and the gallery window, plus
 *    hold-to-save on touch screens.
 *
 * Upstream background:
 *  - Unsent box: `public/scripts/chats.js` binds a `paste` listener on
 *    `#send_textarea` and feeds `event.clipboardData.files` into the
 *    `#file_form_input` attachment flow.
 *  - Edit box: `messageEdit()` in `public/script.js` renders
 *    `<textarea id="curEditTextarea" class="edit_textarea">` and there is
 *    **no** paste listener at all.
 *
 * A pasted image is uploaded through the standard `/api/images/upload` endpoint
 * (the same one `saveBase64AsFile()` uses for the built-in attachment button) and
 * attached to the message being edited as `message.extra.media[]` with
 * `source: 'upload'` + `inline_image: true` — the exact same data shape the
 * built-in "embed file into message" (`.mes_embed`) button produces, so the
 * chat file stays compatible with desktop SillyTavern.
 *
 * Compatibility target: SillyTavern 1.18.x frontend (TauriTavern is synced
 * to 1.18.0). Deliberately avoids `??` / `?.` in *call* position and uses
 * `document.activeElement` + `element.closest()` instead of newer DOM helpers,
 * because Android System WebView on older phones lags behind. No bundler, no
 * dependency beyond the host app itself.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { translate as translateString } from '../../../i18n.js';

/** Key this extension stores its settings under. */
export const MODULE_NAME = 'pcd-extension';

/**
 * Key the extension used before the 1.5.0 rename. Settings are moved over on
 * first run so nobody loses their compression preferences.
 */
export const LEGACY_MODULE_NAME = 'edit-paste-image';

export const DEBUG_PREFIX = '[ImagePlus] ';

/** Reported in the console and the settings drawer; kept in step with manifest.json. */
export const EXTENSION_VERSION = '1.15.0';

/** Hard cap for a single pasted image (25 MB). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Only these mime types are treated as "image" when nothing else matches. */
const IMAGE_MIME_FALLBACK_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/i;

/** Extension part of a mime type, used to name the uploaded file. */
const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
};

/** Reverse of the map above, for naming the output of a re-encode. */
const EXT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

/**
 * Formats accepted by `POST /api/images/upload` (upstream `MEDIA_EXTENSIONS`
 * in `src/constants.js`). Anything else — notably `svg` and `avif` — is
 * rejected by the endpoint with `400 Invalid image format`, so we re-encode
 * those to PNG when the browser can, and only then upload.
 * @type {string[]}
 */
const IMAGE_UPLOAD_FORMATS = ['bmp', 'png', 'jpg', 'webp', 'jpeg', 'jfif', 'gif'];

/** Preferred output formats for automatic compression, best first. */
const COMPRESSION_FORMATS = [
    { mime: 'image/webp', extension: 'webp' },
    { mime: 'image/jpeg', extension: 'jpg' },
];

/** Never shrink below this, however large the source is. */
const COMPRESSION_MIN_EDGE = 320;

/** Candidate sizes tried when quality alone cannot reach the size target. */
const COMPRESSION_SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.25];

/** Rough quality search steps; the loop stops early as soon as it fits. */
const COMPRESSION_QUALITY_STEPS = 10;

/** Poll interval (ms) for reconciling the edit box UI with the DOM. */
const SYNC_INTERVAL_MS = 500;

/** Injected download control. */
const DOWNLOAD_DONE_ATTR = 'data-tt-editpaste-download';
const DOWNLOAD_ICON_IDLE = 'fa-download';
const DOWNLOAD_ICON_BUSY = ['fa-spinner', 'fa-spin'];
const DOWNLOAD_ICON_DONE = 'fa-check';

/** How long a temporary download URL stays alive so the host can pick it up. */
const DOWNLOAD_BLOB_TTL_MS = 30000;

/** Paths that always belong to the local SillyTavern server. */
const LOCAL_MEDIA_PATH_PREFIXES = ['/user/', '/thumbnails/', '/characters/', '/backgrounds/', '/api/'];

/** Attributes that hold the full size original, ahead of `src`. */
const MEDIA_SOURCE_ATTRS = ['data-ngsrc', 'data-src'];

/** Extensions a link must end in before we treat it as the media itself. */
const MEDIA_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|mp4|webm|mov|m4v|mkv)(?:[?#]|$)/i;

/**
 * Viewer surfaces and the corner controls each one gets.
 *
 * `right` is the downloader. `left` is the gallery-only "jump to the message
 * this image came from" control: a chat lightbox is already *on* its message,
 * so the jump only makes sense for the gallery's floating window.
 */
const VIEWER_SURFACES = [
    { selector: '.img_enlarged_container', download: true, jump: false },
    { selector: '.galleryImageDraggable', download: true, jump: true },
];

const VIEWER_CONTAINER_SELECTORS = VIEWER_SURFACES.map((surface) => surface.selector);

const VIEWER_HOST_CLASS = 'tt-editpaste-viewer';
const VIEWER_DOWNLOAD_CLASS = 'tt-editpaste-viewer-download';
const VIEWER_JUMP_CLASS = 'tt-editpaste-viewer-jump';

/** Which side each corner control is pinned to, for repositioning. */
const VIEWER_CONTROLS = [
    { className: VIEWER_DOWNLOAD_CLASS, side: 'right' },
    { className: VIEWER_JUMP_CLASS, side: 'left' },
];

/** Briefly rings the message a gallery jump landed on. */
const FLASH_CLASS = 'tt-editpaste-flash';

/** The collapse bar added above every chat image and media item. */
const MEDIA_BAR_CLASS = 'tt-editpaste-media-bar';
const MEDIA_BAR_ICON_CLASS = 'tt-editpaste-media-bar-icon';
const MEDIA_BAR_TEXT_CLASS = 'tt-editpaste-media-bar-text';
const MEDIA_BAR_FOR_ATTR = 'data-tt-editpaste-bar-for';
const MEDIA_COLLAPSED_CLASS = 'tt-editpaste-media-collapsed';

/**
 * The eye switch at the right end of every bar.
 *
 * Bright means "this picture goes out with the next message", dim means it stays
 * behind. It is a per-picture switch on purpose: what gets sent is a property of
 * the picture, not of whether it happens to be folded right now.
 */
const MEDIA_SEND_CLASS = 'tt-editpaste-media-send';
const MEDIA_SEND_ATTR = 'data-tt-editpaste-send';
const MEDIA_SEND_DIM_CLASS = 'tt-editpaste-send-dim';
const MEDIA_SEND_ON_ICON = 'fa-eye';
const MEDIA_SEND_OFF_ICON = 'fa-eye-slash';

/** This extension's entry in the wand menu. Distinct from the settings button id. */
const WAND_ENTRY_ID = 'tt_editpaste_wand_collapse_all';

/** The wand menu slot this extension creates, following the host's convention. */
const WAND_SLOT_ID = 'tt_editpaste_wand_container';

/** How long that ring stays visible (ms), matching the CSS duration. */
const FLASH_HOLD_MS = 1800;

/** How many of a character's chats the cross-chat search will read. */
const CROSS_CHAT_SEARCH_LIMIT = 200;

/** Waiting for a freshly opened chat to render: how often, and how many times. */
const CHAT_LOAD_POLL_MS = 200;
const CHAT_LOAD_POLL_TRIES = 20;

/**
 * Re-asserting the scroll after a chat switch: the host prints the messages and
 * then scrolls to the bottom, so the jump has to outlast that.
 */
const CHAT_SETTLE_MS = 250;
const CHAT_SETTLE_TRIES = 12;

/** The media kinds a viewer can hold: images, plus generated video. */
const MEDIA_ELEMENT_SELECTOR = 'img, video';

/** Gap (px) between a viewer control and the media's own corner. */
const VIEWER_INSET_PX = 12;

/** Selectors whose click opens the chat image lightbox, so we can react to it. */
const LIGHTBOX_OPENER_SELECTOR = '.mes_img, .mes_media_enlarge';

/** Hold this long (ms) on an image to start a download. */
const LONG_PRESS_MS = 600;

/** A finger may drift this far (px) before the long press is cancelled. */
const LONG_PRESS_SLOP_PX = 12;

/** Images smaller than this are chrome (icons), not something worth saving. */
const LONG_PRESS_MIN_EDGE = 64;
/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
    enabled: true,
    max_image_bytes: MAX_IMAGE_BYTES,
    compress_enabled: false,
    compress_target_kb: 500,
    compress_limit_dimension: false,
    compress_max_edge: 2000,
    compress_min_quality: 0.5,
    /**
     * Off by default: recent TauriTavern handles a long press on an image itself,
     * so this is only needed on older builds that cannot save an image.
     */
    long_press_download: false,
    /** Off by default for the same reason: the viewer's corner download control. */
    viewer_download_button: false,
    /** Puts a collapse bar above every chat image and media item. */
    collapse_media_bars: true,
    /** Off by default: this extension's notices are already quiet, but a reader can silence them. */
    mute_notifications: false,
};

/**
 * Reads this extension's settings block, creating defaults on first run.
 * @returns {any}
 */
export function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        // Carry settings over from the pre-rename key so the compression
        // preferences of existing installs survive the 1.5.0 rename.
        const legacy = extension_settings[LEGACY_MODULE_NAME];
        const carried = legacy && typeof legacy === 'object' ? Object.assign({}, legacy) : null;
        extension_settings[MODULE_NAME] = carried || Object.assign({}, DEFAULT_SETTINGS);
        if (carried) {
            delete extension_settings[LEGACY_MODULE_NAME];
            log('migrated settings from the old "' + LEGACY_MODULE_NAME + '" key');
        }
    }

    const settings = extension_settings[MODULE_NAME];

    // `show_toolbar_button` was dropped in 1.1.0 (the extension no longer
    // injects any UI); clean up the stale key from older installs.
    if ('show_toolbar_button' in settings) {
        delete settings.show_toolbar_button;
    }

    if (typeof settings.enabled !== 'boolean') {
        settings.enabled = DEFAULT_SETTINGS.enabled;
    }
    if (!Number.isFinite(Number(settings.max_image_bytes)) || Number(settings.max_image_bytes) <= 0) {
        settings.max_image_bytes = DEFAULT_SETTINGS.max_image_bytes;
    }

    if (typeof settings.compress_enabled !== 'boolean') {
        settings.compress_enabled = DEFAULT_SETTINGS.compress_enabled;
    }
    if (!Number.isFinite(Number(settings.compress_target_kb)) || Number(settings.compress_target_kb) < 10) {
        settings.compress_target_kb = DEFAULT_SETTINGS.compress_target_kb;
    }
    if (typeof settings.compress_limit_dimension !== 'boolean') {
        settings.compress_limit_dimension = DEFAULT_SETTINGS.compress_limit_dimension;
    }
    if (!Number.isFinite(Number(settings.compress_max_edge)) || Number(settings.compress_max_edge) < 100) {
        settings.compress_max_edge = DEFAULT_SETTINGS.compress_max_edge;
    }
    if (!Number.isFinite(Number(settings.compress_min_quality))
        || Number(settings.compress_min_quality) < 0.1
        || Number(settings.compress_min_quality) > 1) {
        settings.compress_min_quality = DEFAULT_SETTINGS.compress_min_quality;
    }
    if (typeof settings.long_press_download !== 'boolean') {
        settings.long_press_download = DEFAULT_SETTINGS.long_press_download;
    }
    if (typeof settings.viewer_download_button !== 'boolean') {
        settings.viewer_download_button = DEFAULT_SETTINGS.viewer_download_button;
    }
    if (typeof settings.collapse_media_bars !== 'boolean') {
        settings.collapse_media_bars = DEFAULT_SETTINGS.collapse_media_bars;
    }
    if (typeof settings.mute_notifications !== 'boolean') {
        settings.mute_notifications = DEFAULT_SETTINGS.mute_notifications;
    }

    return settings;
}

/**
 * Reads a numeric input and clamps it into range.
 * @param {any} input
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function readClampedNumber(input, min, max, fallback) {
    const value = Number(input && input.value);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

/**
 * Translates a source string through the host locale data when available.
 *
 * The string itself is the translation key, matching how SillyTavern's own
 * translation works: if no entry exists in the locale file the source text is
 * returned unchanged. Two sources are tried because not every host exposes the
 * helper on the extension context (TauriTavern included), so the module export
 * comes first and the context is the fallback. Hosts older than the i18n module
 * simply get the source text.
 *
 * @param {string} text
 * @returns {string}
 */
function translateText(text) {
    try {
        if (typeof translateString === 'function') {
            const result = translateString(text);
            if (typeof result === 'string' && result) {
                return result;
            }
        }
    } catch (error) {
        log('translation lookup failed', error);
    }

    const ctx = safeContext();
    if (ctx && typeof ctx.translate === 'function') {
        try {
            const result = ctx.translate(text);
            if (typeof result === 'string' && result) {
                return result;
            }
        } catch (error) {
            log('context translation lookup failed', error);
        }
    }

    return text;
}

/**
 * Shows a time limited toast through the host, translating the text first.
 *
 * Translation happens *before* the placeholders are filled, otherwise the filled
 * string no longer matches the locale key and the toast stays English.
 *
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 * @param {...any} values values for `${0}`, `${1}`, …
 */
function notify(level, message, ...values) {
    const text = fillPlaceholders(translateText(message), ...values);
    const ctx = safeContext();

    // "Silence every popup" wins over every notice, host toasts included.
    if (getSettings().mute_notifications) {
        log('[muted] ' + text);
        return;
    }

    const hosts = [typeof toastr !== 'undefined' ? toastr : null, ctx ? ctx.toastr : null];

    for (const host of hosts) {
        if (host && typeof host[level] === 'function') {
            host[level](text);
            return;
        }
    }

    if (level === 'error' || level === 'warning') {
        console.warn(DEBUG_PREFIX, text);
    } else {
        log(text);
    }
}

/**
 * Fills `${0}`, `${1}`, … placeholders the same way SillyTavern's `t` does, so
 * translated and untranslated strings report identical numbers.
 * @param {string} template
 * @param {...any} values
 * @returns {string}
 */
function fillPlaceholders(template, ...values) {
    return String(template).replace(/\$\{(\d+)\}/g, (match, index) => {
        const value = values[Number(index)];
        return value === undefined ? match : String(value);
    });
}

/**
 * The quiet line at the bottom of the window.
 *
 * The host toast is a green box in the corner, far too loud for something that
 * fires on every single send. This is deliberately the opposite: small, grey,
 * no shadow, self-fading, and it never takes a click.
 */
const MINI_NOTICE_ID = 'tt_editpaste_notice';
const MINI_NOTICE_CLASS = 'tt-editpaste-notice';
const MINI_NOTICE_VISIBLE_CLASS = 'is-visible';
const MINI_NOTICE_MS = 3200;

let miniNoticeTimer = null;

/**
 * Shows a short, low-contrast line at the bottom of the window.
 * @param {string} text
 */
function miniNotice(text) {
    if (getSettings().mute_notifications) {
        log('[muted] ' + text);
        return;
    }

    if (typeof document === 'undefined' || !document.body) {
        log(text);
        return;
    }

    let node = document.getElementById(MINI_NOTICE_ID);
    if (!node) {
        node = document.createElement('div');
        node.id = MINI_NOTICE_ID;
        node.className = MINI_NOTICE_CLASS;
        node.setAttribute('role', 'status');
        document.body.appendChild(node);
    }

    node.textContent = text;
    anchorMiniNotice(node);
    node.classList.add(MINI_NOTICE_VISIBLE_CLASS);

    if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function' && miniNoticeTimer !== null) {
        window.clearTimeout(miniNoticeTimer);
        miniNoticeTimer = null;
    }
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        miniNoticeTimer = window.setTimeout(() => {
            miniNoticeTimer = null;
            const live = document.getElementById(MINI_NOTICE_ID);
            if (live) {
                live.classList.remove(MINI_NOTICE_VISIBLE_CLASS);
            }
        }, MINI_NOTICE_MS);
    }
}

/**
 * Parks the notice on the seam above the chat input, where the reader is already
 * looking, instead of floating somewhere over the page.
 *
 * Fixed positioning measured against the input box: the host moves that box around
 * as the window resizes and as the textarea grows, so the offset is taken fresh on
 * every notice. With no recognisable input box the stylesheet's own offset applies.
 *
 * @param {Element} node
 */
function anchorMiniNotice(node) {
    node.style.bottom = '';

    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }

    const form = document.getElementById('send_form')
        || document.getElementById('form_sheld')
        || document.getElementById('nonQRFormItems');

    if (!form || typeof form.getBoundingClientRect !== 'function') {
        return;
    }

    const rect = form.getBoundingClientRect();
    const top = rect && Number.isFinite(rect.top) ? rect.top : 0;
    if (top <= 0) {
        return;
    }

    // A hairline of margin so the line does not sit on top of the border itself.
    node.style.bottom = Math.max(0, window.innerHeight - top) + 'px';
}

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Logs through the host logger when available.
 * @param {...any} args
 */
function log(...args) {
    const ctx = safeContext();
    if (ctx && ctx.console && typeof ctx.console.log === 'function') {
        ctx.console.log(DEBUG_PREFIX, ...args);
        return;
    }
    console.log(DEBUG_PREFIX, ...args);
}

/**
 * Returns the ST context, or `null` when the host is not ready yet.
 * @returns {any|null}
 */
function safeContext() {
    try {
        const ctx = getContext();
        return ctx && typeof ctx === 'object' ? ctx : null;
    } catch (error) {
        return null;
    }
}

/**
 * Reads a Blob as a data URL (`data:image/png;base64,...`).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Failed to read the pasted image'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Picks a file extension for a mime type.
 * @param {string} mime
 * @returns {string}
 */
function extensionForMime(mime) {
    const normalized = String(mime || '').toLowerCase();
    if (MIME_TO_EXT[normalized]) {
        return MIME_TO_EXT[normalized];
    }
    const slash = normalized.indexOf('/');
    const guess = slash >= 0 ? normalized.slice(slash + 1) : '';
    return guess && /^[a-z0-9]+$/.test(guess) ? guess : 'png';
}

/** Shared decode helper: loads a blob into an HTMLImageElement. */
const decodeToImage = (blob) => new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
    };
    image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('decode failed'));
    };
    image.src = objectUrl;
});

/** Shared encode helper: draws a source into a canvas of the given size. */
const encodeToBlob = (source, width, height, mime, quality) => new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext('2d');
    if (context) {
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    if (typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
    }
    if (quality === undefined) {
        canvas.toBlob((blob) => resolve(blob), mime);
    } else {
        canvas.toBlob((blob) => resolve(blob), mime, quality);
    }
});

/** Human readable size, for user facing messages. */
function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) {
        return value + ' B';
    }
    if (value < 1024 * 1024) {
        return Math.max(1, Math.round(value / 1024)) + ' KB';
    }
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Re-encodes an image so that it fits the configured size target.
 *
 * Priority: the file size limit comes first. The long edge limit is only
 * applied when it is turned on, and it stops shrinking as soon as the size
 * target is already met.
 *
 * @param {File|Blob} file
 * @param {any} settings
 * @returns {Promise<{blob: Blob, extension: string, compressed: boolean, bytes: number, width: number, height: number, targetKb: number, format: string}|null>}
 *          `null` when there is nothing to do (feature off, already small
 *          enough, or the browser cannot re-encode).
 */
export async function compressImageIfNeeded(file, settings) {
    if (!settings || !settings.compress_enabled) {
        return null;
    }

    const targetBytes = Math.max(10, Number(settings.compress_target_kb) || 0) * 1024;
    if (!targetBytes) {
        return null;
    }

    if (Number(file.size) <= targetBytes) {
        // Already within the size limit: leave it completely alone.
        return null;
    }

    let source;
    try {
        source = await decodeToImage(file);
    } catch (error) {
        log('Cannot decode image for compression', error);
        return null;
    }

    const naturalWidth = source.naturalWidth || source.width || 0;
    const naturalHeight = source.naturalHeight || source.height || 0;
    if (!naturalWidth || !naturalHeight) {
        return null;
    }

    const baseWidth = Math.min(naturalWidth, Number(settings.compress_max_edge) || naturalWidth);
    const scale = baseWidth / naturalWidth;
    const baseHeight = naturalHeight * scale;
    const minQuality = Math.min(1, Math.max(0.1, Number(settings.compress_min_quality) || 0.5));
    let fallbackResult = null;

    for (const candidate of COMPRESSION_FORMATS) {
        for (const step of COMPRESSION_SCALE_STEPS) {
            let width = Math.round(baseWidth * step);
            let height = Math.round(baseHeight * step);
            const longestEdge = Math.max(width, height);
            if (longestEdge < COMPRESSION_MIN_EDGE) {
                break;
            }

            let low = minQuality;
            let high = 1;
            let best = null;
            let bestAnyQuality = null;

            for (let i = 0; i < COMPRESSION_QUALITY_STEPS; i++) {
                const quality = (low + high) / 2;
                const blob = await encodeToBlob(source, width, height, candidate.mime, quality);
                if (!blob || blob.size === 0) {
                    break;
                }

                // Some engines silently fall back to PNG: that is not a
                // compression, so move on to the next candidate format.
                if (blob.type && blob.type !== candidate.mime) {
                    best = null;
                    break;
                }

                if (!bestAnyQuality || blob.size < bestAnyQuality.blob.size) {
                    bestAnyQuality = { blob, quality };
                }

                if (blob.size <= targetBytes) {
                    best = { blob, quality };
                    low = quality;
                } else {
                    high = quality;
                }
            }

            if (best) {
                log('Compressed image to', formatBytes(best.blob.size), 'in', candidate.extension);
                return {
                    blob: best.blob,
                    extension: candidate.extension,
                    compressed: true,
                    bytes: best.blob.size,
                    width,
                    height,
                    targetKb: Math.round(targetBytes / 1024),
                    format: candidate.extension,
                };
            }

            // Nothing reached the target. Remember the smallest result anyway:
            // an unsupported source format still becomes a format the server
            // accepts, which is better than failing the upload.
            if (bestAnyQuality && (!fallbackResult || bestAnyQuality.blob.size < fallbackResult.bytes)) {
                fallbackResult = {
                    blob: bestAnyQuality.blob,
                    extension: candidate.extension,
                    compressed: false,
                    bytes: bestAnyQuality.blob.size,
                    width,
                    height,
                    targetKb: Math.round(targetBytes / 1024),
                    format: candidate.extension,
                };
            }

            // Reachable only when the long edge limit is switched on.
            if (!settings.compress_limit_dimension) {
                break;
            }
        }
    }

    if (fallbackResult) {
        log('Could not reach the requested size; using the smallest result', formatBytes(fallbackResult.bytes));
        return fallbackResult;
    }

    log('Could not re-encode the image, uploading the original');
    return null;
}

/**
 * `POST /api/images/upload` only accepts the upstream `MEDIA_EXTENSIONS`
 * image formats. AVIF / SVG (and anything unusual a clipboard may hand us)
 * are re-encoded to PNG through a canvas so the upload still succeeds and the
 * stored file stays a plain raster image.
 *
 * When automatic compression is enabled and the source is larger than the
 * configured target, a smaller WebP (or JPEG) is produced instead.
 *
 * @param {File|Blob} file
 * @returns {Promise<{blob: Blob, extension: string, compression: any}>}
 */
async function prepareImageForUpload(file) {
    const mime = String(file.type || 'image/png');
    const extension = extensionForMime(mime);

    const compressed = await compressImageIfNeeded(file, getSettings());
    if (compressed) {
        return { blob: compressed.blob, extension: compressed.extension, compression: compressed };
    }

    if (IMAGE_UPLOAD_FORMATS.indexOf(extension) !== -1) {
        return { blob: file, extension: extension, compression: null };
    }

    try {
        const image = await decodeToImage(file);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const pngBlob = await encodeToBlob(image, width, height, 'image/png');

        if (pngBlob && pngBlob.size > 0) {
            log('Re-encoded', mime, 'to PNG for upload');
            return { blob: pngBlob, extension: 'png', compression: null };
        }
    } catch (error) {
        log('Could not re-encode image, uploading the original bytes instead', error);
    }

    // Unsupported format that cannot be re-encoded: the caller falls back to
    // the generic file endpoint, which stores the raw bytes under user/files.
    return { blob: file, extension: extension, compression: null };
}

/**
 * Returns the character name used to namespace the uploaded file, mirroring
 * how upstream `populateFileAttachment` scopes uploads per entity.
 * @param {any} ctx
 * @param {any} message
 * @returns {string}
 */
function resolveUploadName(ctx, message) {
    if (message && message.is_user && ctx && ctx.name1) {
        return String(ctx.name1);
    }
    if (message && message.force_avatar && message.name) {
        return String(message.name);
    }
    if (ctx && ctx.name2) {
        return String(ctx.name2);
    }
    return 'unknown';
}

/**
 * Collects image files out of a clipboard payload.
 * Android WebView puts pasted images in `files`, but some platforms only
 * expose them through `items`, so both are checked.
 * @param {ClipboardEvent} event
 * @returns {File[]}
 */
export function extractImageFiles(event) {
    return collectClipboardFiles(event, { imagesOnly: true });
}

/**
 * Collects every file out of a clipboard payload, images included. The unsent
 * input box path needs this to keep non-image pastes untouched.
 * @param {ClipboardEvent} event
 * @returns {File[]}
 */
export function extractClipboardFiles(event) {
    return collectClipboardFiles(event, { imagesOnly: false });
}

/**
 * Shared clipboard reader for paste based extraction.
 * @param {ClipboardEvent} event
 * @param {{imagesOnly: boolean}} options
 * @returns {File[]}
 */
function collectClipboardFiles(event, options) {
    const clipboard = event ? event.clipboardData : null;
    if (!clipboard) {
        return [];
    }

    const files = [];
    const seen = new Set();

    const push = (file) => {
        if (!file || seen.has(file)) {
            return;
        }
        const mime = String(file.type || '');
        const isImage = mime.startsWith('image/') || IMAGE_MIME_FALLBACK_RE.test(mime);
        if (options.imagesOnly && !isImage) {
            return;
        }
        seen.add(file);
        files.push(file);
    };

    // Engines that expose a pasted image only as an inline data URL inside the
    // text/html flavour. Only self-contained `data:` URLs are accepted, never
    // remote ones, so a paste can never trigger an unexpected network request.
    const pushDataUrls = (html) => {
        const matches = String(html || '').match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi);
        if (!matches) {
            return;
        }
        for (const dataUrl of matches) {
            const mimeMatch = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i.exec(dataUrl);
            const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/png';
            const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s/g, ''));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            push(new File([bytes], 'pasted.' + extensionForMime(mime), { type: mime }));
        }
    };

    if (clipboard.files && clipboard.files.length > 0) {
        for (let i = 0; i < clipboard.files.length; i++) {
            push(clipboard.files[i]);
        }
    }

    if (clipboard.items && clipboard.items.length > 0) {
        for (let i = 0; i < clipboard.items.length; i++) {
            const item = clipboard.items[i];
            if (!item || item.kind !== 'file') {
                continue;
            }
            if (options.imagesOnly && item.type && !String(item.type).startsWith('image/')) {
                continue;
            }
            const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
            push(file);
        }
    }

    if (files.length === 0 && typeof clipboard.getData === 'function') {
        try {
            pushDataUrls(clipboard.getData('text/html'));
        } catch (error) {
            log('Could not read text/html clipboard flavour', error);
        }
    }

    return files;
}

/* ------------------------------------------------------------------ */
/* upload + message mutation                                           */
/* ------------------------------------------------------------------ */

/**
 * Uploads an image bytes payload.
 *
 * Primary path is the endpoint the built-in attachment flow uses
 * (`saveBase64AsFile` -> `POST /api/images/upload`), which stores the file
 * under `user/images/<ch_name>/`. `POST /api/files/upload` is only used when
 * the image endpoint cannot take the payload — either because the server does
 * not implement it, or because the format is outside `MEDIA_EXTENSIONS`
 * (`svg`, `avif`) and could not be re-encoded. The two endpoints delete
 * through *different* routes, so the returned path tells the caller which
 * delete endpoint to use.
 *
 * @param {{image: string, format: string, ch_name: string, filename: string, name: string, data: string}} payload
 * @returns {Promise<string>} served path of the stored file
 */
export async function uploadImage(payload) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
        throw new Error('SillyTavern context is not ready');
    }

    const imageFormatSupported = IMAGE_UPLOAD_FORMATS.indexOf(String(payload.format)) !== -1;

    const attempts = [];

    if (imageFormatSupported) {
        attempts.push({
            url: '/api/images/upload',
            body: {
                image: payload.image,
                format: payload.format,
                ch_name: payload.ch_name,
                // Upstream strips dots from the requested name on purpose.
                filename: String(payload.filename).replace(/\./g, '_'),
            },
        });
    }

    attempts.push({
        url: '/api/files/upload',
        body: {
            name: payload.name,
            data: payload.data,
        },
    });

    let lastError = null;

    for (const attempt of attempts) {
        try {
            const response = await fetch(attempt.url, {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify(attempt.body),
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                lastError = new Error(
                    attempt.url + ' -> ' + response.status + (text ? ': ' + text : ''),
                );
                log('Upload attempt failed', lastError.message);
                continue;
            }

            const result = await response.json();
            const path = result && result.path ? String(result.path) : '';
            if (!path) {
                lastError = new Error(attempt.url + ' did not return a path');
                continue;
            }

            return path;
        } catch (error) {
            lastError = error;
            log('Upload attempt threw', attempt.url, error);
        }
    }

    throw lastError || new Error('Upload failed');
}

/**
 * Makes sure `message.extra.media` exists, preferring the host helper.
 * @param {any} ctx
 * @param {any} message
 * @returns {any[]} the media array
 */
export function ensureMediaArray(ctx, message) {
    if (ctx && typeof ctx.ensureMessageMediaIsArray === 'function') {
        try {
            ctx.ensureMessageMediaIsArray(message);
        } catch (error) {
            log('ensureMessageMediaIsArray failed, falling back', error);
        }
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.media)) {
        message.extra.media = [];
    }

    return message.extra.media;
}

/**
 * Appends an already uploaded image to the message as inline media.
 * The shape matches upstream `populateFileAttachment`, so the chat file
 * stays readable by desktop SillyTavern.
 * @param {any} ctx
 * @param {number} messageId
 * @param {{url: string, title: string}} uploaded
 * @returns {{index: number, media: any}}
 */
export function attachMediaToMessage(ctx, messageId, uploaded) {
    if (!ctx || !Array.isArray(ctx.chat)) {
        throw new Error('Chat is not available');
    }

    const message = ctx.chat[messageId];
    if (!message) {
        throw new Error('Message ' + messageId + ' not found');
    }

    const media = ensureMediaArray(ctx, message);
    const entry = {
        url: uploaded.url,
        type: 'image',
        title: uploaded.title || 'pasted image',
        source: 'upload',
    };

    media.push(entry);
    message.extra.media_index = media.length - 1;
    message.extra.inline_image = true;

    return { index: media.length - 1, media: entry };
}

/**
 * Re-renders the media of a message through the host renderer.
 * @param {any} ctx
 * @param {number} messageId
 * @returns {boolean} whether the host renderer ran
 */
export function renderMessageMedia(ctx, messageId) {
    if (!ctx || typeof ctx.appendMediaToMessage !== 'function' || typeof $ === 'undefined') {
        return false;
    }

    try {
        const message = ctx.chat ? ctx.chat[messageId] : null;
        const host = document.querySelector('.mes[mesid="' + messageId + '"]');
        if (!message || !host) {
            return false;
        }
        ctx.appendMediaToMessage(message, $(host), 'keep');
        return true;
    } catch (error) {
        log('appendMediaToMessage failed', error);
        return false;
    }
}

/**
 * Deletes an uploaded file from the server, picking the endpoint that matches
 * where the file actually lives. Upstream rejects cross-directory deletes
 * (`/api/images/delete` only accepts `user/images/*`, `/api/files/delete` only
 * `user/files/*`), so the path decides the route. Best effort: a failure only
 * means a stale file is left behind, never a broken message.
 * @param {string} url served path of the file
 * @returns {Promise<boolean>}
 */
export async function deleteUploadedFile(url) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
        return false;
    }

    const isImage = String(url || '').indexOf('/user/images/') === 0;
    const endpoint = isImage ? '/api/images/delete' : '/api/files/delete';

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });
        return response.ok;
    } catch (error) {
        log('Failed to delete uploaded file', error);
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* editor UI                                                           */
/* ------------------------------------------------------------------ */

/** messageId -> .mes element for the currently open editor. */
const OPEN_EDITOR_MESSAGE_ID = new Map();
/** .mes element -> messageId. */
const MESSAGE_IDS = new WeakMap();
/** messageId -> busy flag, so double pastes do not upload twice over. */
const BUSY_MESSAGES = new Set();
/** Elements already wired for unsent box compression (bound once each). */
const hookedInputs = new WeakSet();
const hookedTextareas = new WeakSet();
const hookedForms = new WeakSet();
/** Guards the unsent box hook against its own `change` event. */
let sendBoxCompressionRunning = false;

/**
 * Resolves the message id that owns a given `.mes` element.
 * @param {Element} mesElement
 * @returns {number|null}
 */
function resolveMessageId(mesElement) {
    if (!mesElement) {
        return null;
    }
    if (MESSAGE_IDS.has(mesElement)) {
        return MESSAGE_IDS.get(mesElement);
    }

    // Newer ST builds put mesid on `.mes`, older ones on `.mes_block`.
    const candidates = [mesElement, mesElement.querySelector('.mes_block')];
    for (const candidate of candidates) {
        if (!candidate || !candidate.getAttribute) {
            continue;
        }
        const raw = candidate.getAttribute('mesid');
        const parsed = Number(raw);
        if (raw !== null && Number.isInteger(parsed) && parsed >= 0) {
            MESSAGE_IDS.set(mesElement, parsed);
            return parsed;
        }
    }

    return null;
}

/**
 * Returns the `.mes` element that currently hosts an open edit textarea.
 * @returns {{mes: HTMLElement, textarea: HTMLTextAreaElement, messageId: number}|null}
 */
export function getOpenEditor() {
    const active = document.activeElement;
    const fromFocus = active && active.classList && active.classList.contains('edit_textarea')
        ? active
        : null;
    const textarea = /** @type {HTMLTextAreaElement} */ (
        fromFocus || document.querySelector('.mes .edit_textarea')
    );

    if (!textarea) {
        return null;
    }

    const mes = textarea.closest('.mes');
    if (!mes) {
        return null;
    }

    const messageId = resolveMessageId(mes);
    if (messageId === null) {
        return null;
    }

    return { mes, textarea, messageId };
}

/**
 * Shared entry point for paste and drop: uploads the given files into the
 * message that currently has an editor open.
 * @param {File[]} files
 * @returns {Promise<number>} number of successfully attached images
 */
async function attachFilesToOpenEditor(files) {
    const editor = getOpenEditor();
    if (!editor) {
        return 0;
    }

    log('Attaching', files.length, 'image(s) to message', editor.messageId);
    return handleFiles(editor.messageId, files);
}

/* ------------------------------------------------------------------ */
/* the actual feature                                                  */
/* ------------------------------------------------------------------ */

/**
 * Uploads one image and attaches it to the message being edited.
 * @param {number} messageId
 * @param {File|Blob} file
 * @returns {Promise<boolean>}
 */
export async function attachImageToMessage(messageId, file) {
    const settings = getSettings();
    if (!settings.enabled) {
        return false;
    }

    if (!file || typeof file.size !== 'number') {
        return false;
    }

    if (file.size > settings.max_image_bytes) {
        const limitMb = Math.round(settings.max_image_bytes / (1024 * 1024));
        notify('warning', 'Image is larger than ${0} MB and was not attached.', limitMb);
        return false;
    }

    const ctx = safeContext();
    if (!ctx || !Array.isArray(ctx.chat)) {
        notify('error', 'SillyTavern is not ready yet, please try again in a moment.');
        return false;
    }

    const message = ctx.chat[messageId];
    if (!message) {
        notify('error', 'The message to edit was not found.');
        return false;
    }

    const unique = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const chName = resolveUploadName(ctx, message);

    try {
        const prepared = await prepareImageForUpload(file);
        const dataUrl = await blobToDataUrl(prepared.blob);
        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

        const uploadedUrl = await uploadImage({
            image: base64,
            format: prepared.extension,
            ch_name: chName,
            filename: unique,
            name: unique + '.' + prepared.extension,
            data: base64,
        });

        attachMediaToMessage(ctx, messageId, {
            url: uploadedUrl,
            title: chName + ' pasted image',
        });

        if (typeof ctx.saveChat === 'function') {
            await ctx.saveChat();
        }

        renderMessageMedia(ctx, messageId);

        if (prepared.compression) {
            notify('success', 'Image compressed to ${0}.', formatBytes(prepared.compression.bytes));
        }

        log('Attached image to message', messageId, uploadedUrl);
        return true;
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Upload failed', error);
        notify('error', 'Image upload failed: ${0}', error && error.message ? error.message : error);
        return false;
    }
}

/**
 * Handles a batch of files pasted or dropped into the editor.
 * @param {number} messageId
 * @param {File[]} files
 * @returns {Promise<number>} number of successfully attached images
 */
async function handleFiles(messageId, files) {
    if (BUSY_MESSAGES.has(messageId)) {
        notify('info', 'The previous image is still uploading…');
        return 0;
    }

    const images = files.filter((file) => file && String(file.type || '').startsWith('image/'));
    if (images.length === 0) {
        return 0;
    }

    BUSY_MESSAGES.add(messageId);
    let attached = 0;

    try {
        for (const image of images) {
            // eslint-disable-next-line no-await-in-loop -- uploads are sequential on purpose
            const ok = await attachImageToMessage(messageId, image);
            if (ok) {
                attached++;
            }
        }
    } finally {
        BUSY_MESSAGES.delete(messageId);
    }

    return attached;
}

/* ------------------------------------------------------------------ */
/* event wiring                                                        */
/* ------------------------------------------------------------------ */

let syncTimer = null;

/**
 * Removes the drag highlight from every textarea that may still carry it.
 */
function clearDragHighlights() {
    document.querySelectorAll('.edit_textarea.tt-editpaste-drag').forEach((node) => {
        node.classList.remove('tt-editpaste-drag');
    });
}

/**
 * Keeps track of which message currently has an editor open.
 *
 * The extension no longer injects any UI into the editor: pasted and dropped
 * images are attached directly, with no toolbar, picker button or thumbnail
 * preview (the message itself shows the image).
 */
function syncEditors() {
    const editor = getOpenEditor();

    if (!editor) {
        OPEN_EDITOR_MESSAGE_ID.clear();
        clearDragHighlights();
    } else {
        OPEN_EDITOR_MESSAGE_ID.clear();
        OPEN_EDITOR_MESSAGE_ID.set(editor.messageId, editor.mes);
    }

    // Runs whether or not an editor is open: images appear in finished messages,
    // and the lightbox can be open over any of them.
    enhanceImageViewers();
    enhanceMediaCollapse();
    installWandEntry();
}

/**
 * Paste listener for the message edit textarea. Registered once, on
 * `document` in the capture phase (see `startSync`).
 * @param {ClipboardEvent} event
 * @returns {Promise<void>}
 */
async function onPaste(event) {
    const files = extractImageFiles(event);
    if (files.length === 0) {
        // Plain text paste: let the host handle it untouched.
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const editor = getOpenEditor();
    if (!editor) {
        return;
    }

    log('Paste detected in message editor', editor.messageId, files.length, 'image(s)');
    await attachFilesToOpenEditor(files);
}

/**
 * Collects every file out of a drag-and-drop payload, images included.
 * @param {DragEvent} event
 * @returns {File[]}
 */
function extractAllDroppedFiles(event) {
    const transfer = event ? event.dataTransfer : null;
    if (!transfer) {
        return [];
    }

    const files = [];
    if (transfer.files && transfer.files.length > 0) {
        for (let i = 0; i < transfer.files.length; i++) {
            files.push(transfer.files[i]);
        }
    }

    if (files.length === 0 && transfer.items && transfer.items.length > 0) {
        for (let i = 0; i < transfer.items.length; i++) {
            const item = transfer.items[i];
            if (!item || item.kind !== 'file') {
                continue;
            }
            const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
            if (file) {
                files.push(file);
            }
        }
    }

    return files;
}

/**
 * Compresses every oversized image in a file list.
 * @param {File[]} files
 * @param {any} settings
 * @returns {Promise<{files: File[], compressedCount: number, lastBytes: number}>}
 */
async function compressFiles(files, settings) {
    const targetBytes = Math.max(10, Number(settings.compress_target_kb) || 0) * 1024;
    const result = [];
    let compressedCount = 0;
    let lastBytes = 0;

    for (const file of files) {
        if (!file || !String(file.type || '').startsWith('image/') || Number(file.size) <= targetBytes) {
            result.push(file);
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- sequential on purpose
        const compressed = await compressImageIfNeeded(file, settings);
        if (!compressed || !compressed.compressed) {
            // Nothing gained (or nothing reachable): keep the original bytes.
            result.push(file);
            continue;
        }

        compressedCount++;
        lastBytes = compressed.bytes;

        const baseName = String(file.name || 'image').replace(/\.[^.]+$/, '');
        const mime = EXT_TO_MIME[compressed.extension] || 'image/webp';
        result.push(new File(
            [compressed.blob],
            baseName + '.' + compressed.extension,
            { type: mime, lastModified: Date.now() },
        ));
    }

    return { files: result, compressedCount, lastBytes };
}

/**
 * Reports a finished compression through the host toast.
 * @param {number} compressedCount
 * @param {number} lastBytes
 */
function reportCompression(compressedCount, lastBytes) {
    if (compressedCount === 1) {
        notify('success', 'Image compressed to ${0}.', formatBytes(lastBytes));
    } else if (compressedCount > 1) {
        notify(
            'success',
            'Compressed ${0} images; the last one is ${1}.',
            compressedCount,
            formatBytes(lastBytes),
        );
    }
}

/**
 * Files that the unsent input box is currently holding, if they can be read.
 * @returns {File[]|null}
 */
function readSendBoxFiles() {
    const input = document.getElementById('file_form_input');
    if (!input || !input.files || typeof input.files.length !== 'number') {
        return null;
    }
    return Array.from(input.files);
}

/**
 * Cached promise for the host's helper module (`null` when unavailable).
 * @type {Promise<any|null>|null}
 */
let hostUtilsPromise = null;

/**
 * Loads SillyTavern's `/scripts/utils.js` for `humanFileSize`, so the label we
 * redraw matches the host's own formatting byte for byte.
 * @returns {Promise<any|null>}
 */
function loadHostUtilsModule() {
    if (!hostUtilsPromise) {
        hostUtilsPromise = import('../../../utils.js')
            .then((module) => (module && typeof module.humanFileSize === 'function' ? module : null))
            .catch((error) => {
                log('host utils module unavailable, using the built-in size format', error);
                return null;
            });
    }

    return hostUtilsPromise;
}

/**
 * Stand-in for `humanFileSize(bytes, si = false, dp = 1)`, mirroring the host's
 * binary units so a host without the module still renders the same text.
 * @param {number} bytes
 * @returns {string}
 */
function fallbackFileSize(bytes) {
    const value = Number(bytes) || 0;
    const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    if (Math.abs(value) < 1024) {
        return value + ' B';
    }

    let size = value;
    let unit = -1;
    do {
        size /= 1024;
        unit++;
    } while (Math.round(Math.abs(size) * 10) / 10 >= 1024 && unit < units.length - 1);

    return size.toFixed(1) + ' ' + units[unit];
}

/**
 * Formats a byte count the way the host's attachment label does.
 * @param {number} bytes
 * @returns {Promise<string>}
 */
async function formatFileSize(bytes) {
    const module = await loadHostUtilsModule();
    if (module && typeof module.humanFileSize === 'function') {
        try {
            return String(module.humanFileSize(bytes));
        } catch (error) {
            log('humanFileSize failed, using the built-in format', error);
        }
    }

    return fallbackFileSize(bytes);
}

/**
 * Redraws the host's pending-attachment label after the bytes were swapped.
 *
 * Upstream renders `#file_form .file_name` / `.file_size` only from
 * `onFileAttach()` (`public/scripts/chats.js`), which is module-local and is
 * reached two different ways: the paste and drag-drop paths call it directly,
 * while the paperclip button relies on a `change` listener that only exists after
 * that button was clicked. So there is no event we can fire that reliably
 * redraws the label — and firing `change` is actively harmful: the button's
 * listener merges whatever is in `#file_form_input` into a `DataTransfer` it
 * snapshotted on click, and `isSameFile()` compares name/size/type/lastModified,
 * so a re-encoded file counts as *new* and the original would be re-added
 * alongside it. The label is therefore written here, in the host's own format.
 *
 * @param {File[]|FileList} files
 * @returns {Promise<void>}
 */
async function refreshAttachmentLabel(files) {
    const form = document.getElementById('file_form');
    if (!form) {
        return;
    }

    const nameNode = form.querySelector('.file_name');
    const sizeNode = form.querySelector('.file_size');
    if (!nameNode || !sizeNode) {
        return;
    }

    const list = Array.from(files || []);
    if (list.length === 0) {
        form.classList.add('displayNone');
        return;
    }

    const name = list.length === 1
        ? String(list[0].name || '')
        : fillPlaceholders(translateText('${0} files selected'), list.length);
    const totalBytes = list.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const title = list.map((file) => String(file.name || '')).join('\n');

    nameNode.textContent = name;
    nameNode.setAttribute('title', title);
    sizeNode.textContent = await formatFileSize(totalBytes);
    sizeNode.setAttribute('title', String(totalBytes));
    form.classList.remove('displayNone');
}

/**
 * Optional hook for the unsent input box (`#send_textarea`).
 *
 * The host owns that path: it attaches pasted or dropped files to
 * `#file_form_input` and only turns them into base64 when the message is sent.
 * A paste payload cannot be rewritten in flight, so the compression happens
 * right after the host attached the files, and the result is written straight
 * back into the same input. The host's own multi-file merging stays in charge;
 * only the bytes change, plus the label that would otherwise keep describing the
 * pre-compression file.
 *
 * @returns {Promise<void>}
 */
async function compressSendBoxAttachments() {
    const settings = getSettings();
    if (!settings.compress_enabled) {
        return;
    }

    if (sendBoxCompressionRunning) {
        return;
    }

    const files = readSendBoxFiles();
    if (!files || files.length === 0) {
        return;
    }

    const targetBytes = Math.max(10, Number(settings.compress_target_kb) || 0) * 1024;
    const oversized = files.some((file) => file
        && String(file.type || '').startsWith('image/')
        && Number(file.size) > targetBytes);

    if (!oversized) {
        return;
    }

    sendBoxCompressionRunning = true;

    try {
        const { files: nextFiles, compressedCount, lastBytes } = await compressFiles(files, settings);
        if (compressedCount > 0 && typeof DataTransfer === 'function') {
            const transfer = new DataTransfer();
            for (const file of nextFiles) {
                transfer.items.add(file);
            }
            const input = document.getElementById('file_form_input');
            if (input) {
                // Deliberately no `change` event: see `refreshAttachmentLabel`.
                input.files = transfer.files;
                await refreshAttachmentLabel(transfer.files);
            }
            reportCompression(compressedCount, lastBytes);
            log('Compressed', compressedCount, 'image(s) for the unsent input box');
        }
    } catch (error) {
        log('Unsent box compression failed', error);
    } finally {
        sendBoxCompressionRunning = false;
    }
}

/**
 * Hooks the unsent box on the way in, so the added files can be compressed
 * before the host shows or uploads them. Bound once per element.
 * @param {HTMLInputElement} input the host's hidden file input
 * @param {HTMLElement} textarea `#send_textarea`
 */
function installSendBoxHooks(input, textarea) {
    if (!hookedInputs.has(input)) {
        hookedInputs.add(input);
        input.addEventListener('change', () => {
            window.setTimeout(() => {
                compressSendBoxAttachments().catch((error) => log('send box hook failed', error));
            }, 0);
        });
    }

    if (textarea && !hookedTextareas.has(textarea)) {
        hookedTextareas.add(textarea);
        textarea.addEventListener('paste', () => {
            window.setTimeout(() => {
                compressSendBoxAttachments().catch((error) => log('send box paste hook failed', error));
            }, 0);
        });

        const form = textarea.closest('#form_sheld') || document.getElementById('form_sheld');
        if (form && !hookedForms.has(form)) {
            hookedForms.add(form);
            form.addEventListener('drop', () => {
                window.setTimeout(() => {
                    compressSendBoxAttachments().catch((error) => log('send box drop hook failed', error));
                }, 0);
            });
        }
    }
}

/**
 * Look up and hook the unsent box elements when they exist.
 */
function syncSendBoxHooks() {
    const input = document.getElementById('file_form_input');
    if (!input) {
        return;
    }

    const textarea = document.getElementById('send_textarea');
    installSendBoxHooks(input, textarea);
}

/**
 * Extracts image files out of a drag-and-drop payload.
 * @param {DragEvent} event
 * @returns {File[]}
 */
export function extractDroppedImages(event) {
    return extractAllDroppedFiles(event)
        .filter((file) => file && String(file.type || '').startsWith('image/'));
}

/**
 * Marks the hovered edit textarea while an image is dragged over it.
 * @param {DragEvent} event
 */
function onDragOver(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('edit_textarea')) {
        return;
    }

    // Required for the browser to fire `drop` at all.
    event.preventDefault();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
    target.classList.add('tt-editpaste-drag');
}

/**
 * Clears the hover highlight when the drag leaves the textarea.
 * @param {DragEvent} event
 */
function onDragLeave(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('edit_textarea')) {
        return;
    }
    target.classList.remove('tt-editpaste-drag');
}

/**
 * Handles an image dropped onto the edit textarea.
 *
 * `preventDefault()` on `dragover` (see `onDragOver`) is what makes the drop
 * possible at all. `stopPropagation()` here keeps the host from treating the
 * same drop as a file to attach to the *next* message, which would attach the
 * image twice in two different places.
 *
 * @param {DragEvent} event
 * @returns {Promise<void>}
 */
async function onDrop(event) {
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains('edit_textarea')) {
        return;
    }

    const images = extractDroppedImages(event);
    if (images.length === 0) {
        // Not an image (or a text/plain drag): let the host deal with it.
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearDragHighlights();

    log('Drop detected on message editor', images.length, 'image(s)');
    await attachFilesToOpenEditor(images);
}

/**
 * Registers the paste / drag-and-drop listeners and the editor reconciler.
 *
 * The listeners live on `document` in the **capture** phase, which is the
 * single entry point for every gesture: capture runs before anything bound on
 * a textarea itself, so the edit box path can reliably suppress the host
 * default. The unsent input box is handled by the host, and this extension
 * hooks it separately (see `installSendBoxHooks`).
 */
function startSync() {
    if (syncTimer === null) {
        syncTimer = window.setInterval(() => {
            try {
                syncEditors();
                syncSendBoxHooks();
            } catch (error) {
                console.error(DEBUG_PREFIX, 'syncEditors failed', error);
            }
        }, SYNC_INTERVAL_MS);
    }

    const isTarget = (event, className) => Boolean(event && event.target
        && event.target.classList && event.target.classList.contains(className));

    const guard = (handler) => (event) => {
        try {
            handler(event);
        } catch (error) {
            console.error(DEBUG_PREFIX, 'gesture handler failed', error);
        }
    };

    document.addEventListener('paste', guard((event) => {
        if (!isTarget(event, 'edit_textarea')) {
            return;
        }
        onPaste(event).catch((error) => console.error(DEBUG_PREFIX, 'paste handler failed', error));
    }), true);

    document.addEventListener('dragover', guard((event) => {
        if (isTarget(event, 'edit_textarea')) {
            onDragOver(event);
        }
    }), true);

    document.addEventListener('dragleave', guard((event) => {
        if (isTarget(event, 'edit_textarea')) {
            onDragLeave(event);
        }
    }), true);

    document.addEventListener('drop', guard((event) => {
        if (!isTarget(event, 'edit_textarea')) {
            return;
        }
        onDrop(event).catch((error) => console.error(DEBUG_PREFIX, 'drop handler failed', error));
    }), true);
}

/* ------------------------------------------------------------------ */
/* image download (host download bridge)                               */
/* ------------------------------------------------------------------ */

/**
 * Turns an image URL into a safe file name.
 * @param {string} url
 * @returns {string}
 */
export function fileNameFromImageUrl(url) {
    let candidate = '';
    try {
        const parsed = new URL(String(url), 'https://localhost/');
        candidate = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    } catch (error) {
        candidate = String(url || '').split('/').pop() || '';
    }

    const cleaned = candidate
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/[.\s]+$/g, '')
        .trim();

    if (!cleaned) {
        return 'image.png';
    }
    if (!/\.[a-z0-9]{2,5}$/i.test(cleaned)) {
        return cleaned + '.png';
    }
    return cleaned;
}

/**
 * Reads `window.location.href`, tolerating a host without one.
 * @returns {string}
 */
function currentLocationHref() {
    try {
        return String((window.location && window.location.href) || '');
    } catch (error) {
        return '';
    }
}

/**
 * Reads `window.location.origin`, tolerating a host without one.
 * @returns {string}
 */
function currentLocationOrigin() {
    try {
        return String((window.location && window.location.origin) || '');
    } catch (error) {
        return '';
    }
}

/**
 * Keeps the download href on the host's own origin.
 *
 * The host's download bridge refuses anchors that point anywhere else and then
 * does nothing at all, so a URL that only differs by host alias (localhost vs
 * 127.0.0.1) is rewritten to its path. Genuinely remote URLs are handed over
 * untouched, because for those the browser is the only thing that can help.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeDownloadHref(url) {
    const raw = String(url || '').trim();
    if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) {
        return raw;
    }

    const base = currentLocationHref();
    if (!base) {
        return raw;
    }

    let parsed = null;
    try {
        parsed = new URL(raw, base);
    } catch (error) {
        return raw;
    }

    if (parsed.origin === currentLocationOrigin()) {
        return raw;
    }

    for (const prefix of LOCAL_MEDIA_PATH_PREFIXES) {
        if (parsed.pathname.startsWith(prefix)) {
            return parsed.pathname + parsed.search;
        }
    }

    return parsed.href;
}

/**
 * Fetches the image bytes so the host can save them straight from memory.
 *
 * On TauriTavern mobile the host keeps a map of every `URL.createObjectURL`
 * result, and a `blob:` anchor skips both its own second fetch and its same
 * origin check. When the bytes cannot be read the caller falls back to the URL.
 *
 * @param {string} href
 * @returns {Promise<Blob|null>}
 */
async function readImageBlob(href) {
    if (typeof fetch !== 'function') {
        return null;
    }

    try {
        const response = await fetch(href);
        if (response && response.ok && typeof response.blob === 'function') {
            return await response.blob();
        }
        log('Image payload request was refused', response ? response.status : 'no response');
    } catch (error) {
        log('Image payload request failed', error);
    }

    return null;
}

/**
 * Frees a temporary download URL once the host has had time to pick it up.
 * @param {string} objectUrl
 */
function releaseObjectUrl(objectUrl) {    if (!objectUrl) {
        return;
    }

    window.setTimeout(() => {
        try {
            URL.revokeObjectURL(objectUrl);
        } catch (error) {
            log('Failed to release the download URL', error);
        }
    }, DOWNLOAD_BLOB_TTL_MS);
}

/**
 * Reports whether an href already points at the host itself.
 *
 * Relative hrefs count, because the browser resolves them against the page.
 * @param {string} href
 * @returns {boolean}
 */
function isSameOriginHref(href) {
    const origin = currentLocationOrigin();
    if (!origin) {
        return true;
    }

    try {
        return new URL(href, currentLocationHref() || origin).origin === origin;
    } catch (error) {
        return true;
    }
}

/**
 * Creates the download anchor, clicks it and reports what happened.
 *
 * The host bridges downloads from a capture phase listener on `document`, which
 * calls `preventDefault()`. Reading that flag from our own listener is the only
 * way to tell "the host is saving this" apart from "nothing will happen".
 *
 * @param {string} href the image URL, for reporting
 * @param {string} anchorHref where the anchor should point
 * @param {string} fileName
 * @param {'direct'|'blob'} mode
 * @param {string} [objectUrl] temporary URL to release once the host looked at it
 * @returns {{ok: boolean, bridged: boolean, url: string, name: string, mode: string}}
 */
function clickDownloadAnchor(href, anchorHref, fileName, mode, objectUrl) {
    const anchor = document.createElement('a');
    anchor.href = anchorHref;
    anchor.setAttribute('download', fileName);
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    // Must be connected so the host's document level listener sees the click.
    document.body.appendChild(anchor);

    let dispatched = false;
    let prevented = false;
    const onAnchorClick = (event) => {
        dispatched = true;
        prevented = Boolean(event.defaultPrevented);
    };

    anchor.addEventListener('click', onAnchorClick);
    let bridged = false;
    try {
        anchor.click();
        // A host that swallows the click inside its own `click` patch never dispatches.
        bridged = dispatched ? prevented : true;
    } finally {
        anchor.removeEventListener('click', onAnchorClick);
        anchor.remove();
    }

    releaseObjectUrl(objectUrl);
    return { ok: true, bridged, url: href, name: fileName, mode };
}

/**
 * Cached promise for TauriTavern's export module (`null` when this host has none).
 *
 * The promise itself is cached, not a "already tried" flag: two downloads started
 * in the same tick must not race, with the loser silently dropping to the anchor
 * route.
 *
 * @type {Promise<any|null>|null}
 */
let hostExportPromise = null;

/**
 * Loads TauriTavern's own export pipeline on demand.
 *
 * A plain SillyTavern has no `/scripts/file-export.js`, and a static import
 * would take the whole extension down with it, so this stays a guarded dynamic
 * import. It is the very module the host's built-in Exports use, which is what
 * makes the native Android (MediaStore) and iOS (share sheet) paths work without
 * depending on the anchor bridge.
 *
 * @returns {Promise<any|null>}
 */
function loadHostExportModule() {
    if (!hostExportPromise) {
        hostExportPromise = import('../../../file-export.js')
            .then((module) => {
                if (module && typeof module.downloadBlobWithRuntime === 'function') {
                    log('using the host export pipeline for downloads');
                    return module;
                }
                log('host file-export module exposes no downloadBlobWithRuntime');
                return null;
            })
            .catch((error) => {
                log('host file-export module unavailable, downloads fall back to an anchor', error);
                return null;
            });
    }

    return hostExportPromise;
}

/**
 * Downloads an image through the host's download bridge.
 *
 * Two routes, tried in this order:
 *
 * 1. TauriTavern's own export module (`/scripts/file-export.js`), the exact code
 *    its built-in "Export" buttons use. It stages the bytes and calls the native
 *    Android (MediaStore) / iOS (share sheet) bridge, so there is no anchor to be
 *    intercepted and no origin rule to satisfy. Plain SillyTavern has no such
 *    file, hence the guarded dynamic import.
 * 2. Everywhere else: a synthetic `<a download>` click, which the browser saves
 *    and which TauriTavern's `download-bridge.js` also intercepts on mobile.
 *
 * @param {string} url image URL (already served by the host)
 * @param {string} [name] optional file name
 * @returns {Promise<{ok: boolean, bridged: boolean, url: string, name: string, mode: string}>}
 */
export async function downloadImageUrl(url, name) {
    const source = String(url || '').trim();
    const href = normalizeDownloadHref(source);
    if (!href) {
        return { ok: false, bridged: false, url: href, name: '', mode: 'none' };
    }

    const fileName = fileNameFromImageUrl(name || source || href);
    const host = await loadHostExportModule();
    if (host) {
        return downloadImageViaHost(host, href, fileName);
    }

    return downloadImageViaAnchor(href, fileName);
}

/**
 * Fallback route: click a synthetic anchor and let the browser — or the host's
 * anchor bridge — save it.
 *
 * Exported so it stays directly testable: on a TauriTavern host the route above
 * always wins, and this one only runs on hosts without the export module.
 *
 * @param {string} url image URL
 * @param {string} [name] optional file name
 * @returns {Promise<{ok: boolean, bridged: boolean, url: string, name: string, mode: string}>}
 */
export async function downloadImageViaAnchor(url, name) {
    const source = String(url || '').trim();
    const href = normalizeDownloadHref(source);
    if (!href) {
        return { ok: false, bridged: false, url: href, name: '', mode: 'none' };
    }

    const fileName = fileNameFromImageUrl(name || source || href);

    // A local URL is what the host bridge expects, and the click has to stay
    // inside the user gesture, so this path never waits for anything.
    if (isSameOriginHref(href)) {
        log('Downloading image', fileName, 'from', href, '(direct)');
        return clickDownloadAnchor(href, href, fileName, 'direct');
    }

    // Foreign URLs are refused by the host bridge, so fetch the bytes here and
    // hand it a blob it can read straight out of memory.
    let objectUrl = '';
    const blob = await readImageBlob(href);
    if (blob) {
        try {
            objectUrl = URL.createObjectURL(blob);
        } catch (error) {
            log('Failed to create a download URL', error);
            objectUrl = '';
        }
    }

    const mode = objectUrl ? 'blob' : 'direct';
    log('Downloading image', fileName, 'from', href, '(' + mode + ')');
    return clickDownloadAnchor(href, objectUrl || href, fileName, mode, objectUrl);
}

/**
 * Hands the image to TauriTavern's own export pipeline.
 * @param {any} host the `/scripts/file-export.js` module
 * @param {string} href
 * @param {string} fileName
 * @returns {Promise<{ok: boolean, bridged: boolean, url: string, name: string, mode: string}>}
 */
async function downloadImageViaHost(host, href, fileName) {
    const blob = await readImageBlob(href);
    if (!blob) {
        throw new Error('the image payload could not be read');
    }

    const result = await host.downloadBlobWithRuntime(blob, fileName, { fallbackName: fileName });
    log('Host export finished', describeExportResult(result, fileName));
    notify('success', 'Image saved: ${0}', describeExportResult(result, fileName));
    return { ok: true, bridged: true, url: href, name: fileName, mode: 'host' };
}

/**
 * Describes where the host put the file, for the confirmation toast.
 * @param {any} result
 * @param {string} fileName
 * @returns {string}
 */
function describeExportResult(result, fileName) {
    if (!result || typeof result !== 'object') {
        return fileName;
    }

    const savedPath = typeof result.savedPath === 'string' ? result.savedPath.trim() : '';
    if (savedPath) {
        return savedPath;
    }

    const displayName = typeof result.displayName === 'string' ? result.displayName.trim() : '';
    return displayName || fileName;
}

/**
 * Reports whether the app is a mobile Tauri shell, where a download that no host
 * bridge picked up would otherwise fail without any feedback at all.
 * @returns {boolean}
 */
function isNativeMobileShell() {
    try {
        if (!window.__TAURI_INTERNALS__ && !window.__TAURI__ && !window.__TAURI_RUNNING__) {
            return false;
        }
        const userAgent = String((window.navigator && window.navigator.userAgent) || '');
        return /android|iphone|ipad|ipod/i.test(userAgent);
    } catch (error) {
        return false;
    }
}

/**
 * Opens the image itself, as a last resort when no download route worked.
 *
 * On TauriTavern this hands the URL to the system browser, where the image can
 * be saved with the platform's own long press.
 *
 * @param {string} src
 * @returns {boolean} true when something was opened
 */
function openImageLocation(src) {
    const target = String(src || '').trim();
    if (!target) {
        return false;
    }

    let absolute = target;
    try {
        absolute = new URL(target, currentLocationHref() || undefined).href;
    } catch (error) {
        absolute = target;
    }

    try {
        const tauri = window.__TAURI__;
        if (tauri && tauri.opener && typeof tauri.opener.openUrl === 'function') {
            tauri.opener.openUrl(absolute).catch((error) => {
                console.error(DEBUG_PREFIX, 'opener failed', error);
            });
            return true;
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, 'opener unavailable', error);
    }

    try {
        window.open(absolute, '_blank', 'noopener');
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Picks the best URL to save for a media element.
 *
 * Three sources, best first: a gallery's `data-ngsrc` (the original, when `src`
 * holds a thumbnail), a wrapping link that points at a media file, and finally
 * the element's own `src`.
 *
 * Text-to-image results do not need any special handling here: they are ordinary
 * `message.extra.media` entries with `source: 'generated'` and are rendered by
 * the very same `#message_image_template` clone, so the same markup applies.
 * Video results use `<video class="mes_video">` instead, which is why the
 * selector below is not `img`-only.
 *
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {string}
 */
function mediaSourceForDownload(media) {
    for (const attribute of MEDIA_SOURCE_ATTRS) {
        const value = String(media.getAttribute(attribute) || '').trim();
        if (value) {
            return value;
        }
    }

    const link = typeof media.closest === 'function' ? media.closest('a[href]') : null;
    const href = link ? String(link.getAttribute('href') || '').trim() : '';
    if (href && MEDIA_FILE_RE.test(href)) {
        return href;
    }

    return String(
        media.getAttribute('src') || media.currentSrc || media.src || '',
    ).trim();
}

/**
 * Runs a download and reports the outcome, whichever surface started it.
 * @param {Element|null} feedback control to animate, when there is one
 * @param {string} src
 * @returns {Promise<void>}
 */
async function runDownloadAction(feedback, src) {
    const source = String(src || '').trim();
    if (!source) {
        return;
    }
    if (feedback && feedback.getAttribute(DOWNLOAD_DONE_ATTR) === 'busy') {
        return;
    }

    if (feedback) {
        feedback.setAttribute(DOWNLOAD_DONE_ATTR, 'busy');
        markDownloadControl(feedback, 'busy');
    }

    try {
        const result = await downloadImageUrl(source);
        if (feedback) {
            markDownloadControl(feedback, 'done');
        }
        if (!result.ok) {
            notify('error', 'Failed to download the image.');
        } else if (!result.bridged && isNativeMobileShell()) {
            console.error(DEBUG_PREFIX, 'the app did not take over the download', result);
            notify('warning', 'The app did not take over the download. Update TauriTavern and try again.');
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, 'download failed', error);
        const reason = error && error.message ? error.message : String(error);
        if (openImageLocation(source)) {
            notify('warning', 'Download failed: ${0} The image was opened instead.', reason);
        } else {
            notify('error', 'Failed to download the image: ${0}', reason);
        }
    } finally {
        if (feedback) {
            window.setTimeout(() => {
                feedback.removeAttribute(DOWNLOAD_DONE_ATTR);
            }, 1500);
        }
    }
}

/**
 * Pins a viewer control to the media's own corner.
 *
 * The viewer box is usually larger than the picture (letterboxing, `object-fit:
 * contain`), so anchoring to the box would leave the control floating away from
 * the media. Offsets are measured against the media instead, and clamped to the
 * viewer so that a zoomed-in picture never pushes the control out of sight.
 *
 * @param {Element} container
 * @param {Element} control
 * @param {'left'|'right'} side
 */
function positionViewerControl(container, control, side) {
    const media = container.querySelector(MEDIA_ELEMENT_SELECTOR);
    if (!media
        || typeof media.getBoundingClientRect !== 'function'
        || typeof container.getBoundingClientRect !== 'function') {
        return;
    }

    const mediaRect = media.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!mediaRect.width || !mediaRect.height || !containerRect.width || !containerRect.height) {
        return;
    }

    const gapBottom = Math.round(containerRect.bottom - mediaRect.bottom);
    control.style.bottom = Math.max(VIEWER_INSET_PX, gapBottom + VIEWER_INSET_PX) + 'px';

    if (side === 'left') {
        const gapLeft = Math.round(mediaRect.left - containerRect.left);
        control.style.left = Math.max(VIEWER_INSET_PX, gapLeft + VIEWER_INSET_PX) + 'px';
        return;
    }

    const gapRight = Math.round(containerRect.right - mediaRect.right);
    control.style.right = Math.max(VIEWER_INSET_PX, gapRight + VIEWER_INSET_PX) + 'px';
}

/**
 * Repositions every control that is actually in this viewer.
 * @param {Element} container
 */
function repositionViewer(container) {
    for (const entry of VIEWER_CONTROLS) {
        const control = container.querySelector('.' + entry.className);
        if (control) {
            positionViewerControl(container, control, entry.side);
        }
    }
}

/**
 * Builds the corner control that sits inside a viewer.
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {Element}
 */
function makeViewerDownloadButton(media) {
    const button = document.createElement('div');
    button.className = 'fa-solid fa-download ' + VIEWER_DOWNLOAD_CLASS;
    button.setAttribute('title', translateText('Download image'));
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.addEventListener('click', (event) => {
        // The lightbox closes on any click inside it, so this must not bubble.
        event.preventDefault();
        event.stopPropagation();
        runDownloadAction(button, mediaSourceForDownload(media)).catch((error) => {
            console.error(DEBUG_PREFIX, 'viewer download failed', error);
        });
    });

    return button;
}

/**
 * Builds the gallery-only "go to the message this came from" control.
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {Element}
 */
function makeViewerJumpButton(media) {
    const button = document.createElement('div');
    button.className = 'fa-solid fa-location-arrow ' + VIEWER_JUMP_CLASS;
    button.setAttribute('title', translateText('Jump to the message with this image'));
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        runJumpToMessage(mediaSourceForDownload(media), button).catch((error) => {
            console.error(DEBUG_PREFIX, 'jump to message failed', error);
        });
    });

    return button;
}

/**
 * Adds one corner control to a viewer, or just repositions it when it is there.
 * @param {Element} container
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @param {string} className
 * @param {'left'|'right'} side
 * @param {(media: any) => Element} build
 */
function ensureViewerControl(container, media, className, side, build) {
    const existing = container.querySelector('.' + className);
    if (existing) {
        positionViewerControl(container, existing, side);
        return;
    }

    const control = build(media);
    container.appendChild(control);
    positionViewerControl(container, control, side);
    media.addEventListener('load', () => positionViewerControl(container, control, side));
}

/**
 * Adds (and keeps positioned) the corner controls in every media viewer.
 *
 * Neither SillyTavern's chat lightbox (`expandMessageMedia`) nor the gallery's
 * floating window ships any, and both are ordinary nodes in this document, so a
 * corner control is all it takes. Running on every reconciler tick doubles as the
 * repositioning pass: it catches late media layout, the click that toggles zoom,
 * and window resizes without needing a ResizeObserver.
 */
function enhanceImageViewers() {
    const settings = getSettings();

    // Turning the download control off has to take effect immediately, not just
    // stop adding new ones.
    if (!settings.viewer_download_button) {
        for (const stale of document.querySelectorAll('.' + VIEWER_DOWNLOAD_CLASS)) {
            stale.remove();
        }
    }

    for (const surface of VIEWER_SURFACES) {
        for (const container of document.querySelectorAll(surface.selector)) {
            const media = container.querySelector(MEDIA_ELEMENT_SELECTOR);
            if (!media || !mediaSourceForDownload(media)) {
                continue;
            }

            container.classList.add(VIEWER_HOST_CLASS);

            if (surface.download && settings.viewer_download_button) {
                ensureViewerControl(container, media, VIEWER_DOWNLOAD_CLASS, 'right', makeViewerDownloadButton);
            }
            if (surface.jump) {
                ensureViewerControl(container, media, VIEWER_JUMP_CLASS, 'left', makeViewerJumpButton);
            }
        }
    }
}

/**
 * Repositions every viewer control after something a tick might miss.
 * @param {Element} container
 */
function repositionViewerSoon(container) {
    window.setTimeout(() => repositionViewer(container), 0);
}

/**
 * Keeps the corner control in step with a lightbox that is opening right now.
 *
 * The lightbox is created by a click we cannot hook into directly, so this runs
 * a few short retries on top of the regular reconciler tick.
 * @param {number} [attempt]
 */
function refreshViewersSoon(attempt = 0) {
    enhanceImageViewers();
    if (attempt >= 4) {
        return;
    }
    window.setTimeout(() => refreshViewersSoon(attempt + 1), 120);
}

/**
 * Normalises a media URL so a gallery path and a message URL compare equal.
 *
 * The gallery serves `user/images/<folder>/<file>` while the message stores
 * `/user/images/<name>/<file>`, and either may carry a query or percent escapes.
 *
 * @param {string} url
 * @returns {string}
 */
function mediaPathKey(url) {
    let value = String(url || '').trim();
    if (!value) {
        return '';
    }

    try {
        value = new URL(value, currentLocationHref() || 'https://localhost/').pathname;
    } catch (error) {
        value = value.split('?')[0].split('#')[0];
    }

    try {
        value = decodeURIComponent(value);
    } catch (error) {
        // Leave malformed percent escapes alone rather than dropping the value.
    }

    return value.replace(/^\/+/, '');
}

/**
 * Finds the message that shows this media, so the chat can jump to it.
 *
 * An exact path match wins. When nothing matches, the bare file name is accepted
 * if it is unique across the chat, so a gallery that serves the same file under a
 * slightly different path still lands somewhere sensible.
 *
 * @param {string} url
 * @returns {number|null} message id, or null when the chat does not show it
 */
function findMessageIdForMedia(url) {
    const ctx = safeContext();
    const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
    return findMessageIdInMessages(chat, url);
}

/**
 * Finds the id of the message in `messages` that shows this media.
 *
 * Entries without a `mes` string are skipped, which conveniently also skips the
 * chat header that `/api/chats/get` puts at index 0.
 *
 * @param {any[]} messages
 * @param {string} url
 * @returns {number|null}
 */
function findMessageIdInMessages(messages, url) {
    const key = mediaPathKey(url);
    if (!key || !Array.isArray(messages)) {
        return null;
    }

    const base = key.split('/').pop();
    let byBaseName = null;
    let byBaseNameCount = 0;

    for (let id = 0; id < messages.length; id++) {
        const message = messages[id];
        if (!message || typeof message.mes !== 'string') {
            continue;
        }

        const media = message.extra && Array.isArray(message.extra.media)
            ? message.extra.media
            : [];

        for (const entry of media) {
            const entryKey = mediaPathKey(entry && entry.url);
            if (!entryKey) {
                continue;
            }
            if (entryKey === key) {
                return id;
            }
            if (entryKey.split('/').pop() === base) {
                byBaseName = id;
                byBaseNameCount++;
            }
        }
    }

    return byBaseNameCount === 1 ? byBaseName : null;
}

/**
 * Normalises a chat file name for comparison; the endpoints accept it with or
 * without the `.jsonl` suffix.
 * @param {string} fileName
 * @returns {string}
 */
function chatFileKey(fileName) {
    return String(fileName || '').trim().replace(/\.jsonl$/i, '');
}

/**
 * The chat file that is open right now, if the host exposes it.
 * @returns {string}
 */
function currentChatFile() {
    const ctx = safeContext();
    if (!ctx) {
        return '';
    }

    try {
        if (typeof ctx.getCurrentChatId === 'function') {
            return String(ctx.getCurrentChatId() || '');
        }
    } catch (error) {
        log('getCurrentChatId failed', error);
    }

    return String(ctx.chatId || '');
}

/**
 * The character currently selected in the chat, in the shape the chat endpoints
 * want.
 * @returns {{id: number, avatar: string, name: string}|null}
 */
function currentCharacterIdentity() {
    const ctx = safeContext();
    if (!ctx || !Array.isArray(ctx.characters)) {
        return null;
    }

    const id = Number(ctx.characterId);
    if (!Number.isFinite(id) || id < 0) {
        return null;
    }

    const character = ctx.characters[id];
    if (!character || !character.avatar) {
        return null;
    }

    return { id, avatar: String(character.avatar), name: String(character.name || '') };
}

/**
 * The character a media path belongs to.
 *
 * `user/images/<folder>/<file>` uses the character's avatar file name without its
 * extension (`getCharaFilename`), so the folder is matched against
 * `characters[].avatar`. This is what makes the search follow the *gallery's*
 * folder picker: the gallery can be pointed at character B while the chat is
 * still showing character A, and the jump has to look in B's chats.
 *
 * Falls back to the open character when the path carries no folder (for example
 * an image saved straight into `user/images/`) or when nothing matches.
 *
 * @param {string} url
 * @returns {{id: number, avatar: string, name: string}|null}
 */
function characterIdentityForMedia(url) {
    const ctx = safeContext();
    if (!ctx || !Array.isArray(ctx.characters)) {
        return null;
    }

    const parts = mediaPathKey(url).split('/');
    const folder = parts.length > 3 && parts[0] === 'user' && parts[1] === 'images' ? parts[2] : '';
    if (!folder) {
        return currentCharacterIdentity();
    }

    for (let id = 0; id < ctx.characters.length; id++) {
        const character = ctx.characters[id];
        if (!character || !character.avatar) {
            continue;
        }
        if (String(character.avatar).replace(/\.[^/.]+$/, '') === folder) {
            return { id, avatar: String(character.avatar), name: String(character.name || '') };
        }
    }

    log('no character matches the image folder', folder, '- falling back to the open one');
    return currentCharacterIdentity();
}

/**
 * Waits for the requested time. Kept separate so tests can see the loop shape.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

/**
 * The rendered element of a message.
 * @param {number} messageId
 * @returns {Element|null}
 */
function messageNode(messageId) {
    const selector = '.mes[mesid="' + messageId + '"]';
    return document.querySelector('#chat ' + selector) || document.querySelector(selector);
}

/**
 * Scrolls a message into view.
 * @param {Element} node
 * @param {boolean} smooth animate the scroll (only safe when nothing else is scrolling)
 */
function scrollMessageIntoView(node, smooth) {
    if (typeof node.scrollIntoView !== 'function') {
        return;
    }

    if (!smooth) {
        node.scrollIntoView({ block: 'center' });
        return;
    }

    try {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (error) {
        log('smooth scroll refused, jumping directly', error);
        node.scrollIntoView();
    }
}

/**
 * Rings a message for a moment.
 * @param {Element} node
 */
function flashMessage(node) {
    node.classList.add(FLASH_CLASS);
    window.setTimeout(() => node.classList.remove(FLASH_CLASS), FLASH_HOLD_MS);
}

/**
 * Reports whether a message currently sits inside the chat's visible area.
 *
 * Without layout information (a hidden chat, or a test double) this answers
 * `true`: there is nothing to fight over, so the scroll can be called done.
 *
 * @param {Element} node
 * @returns {boolean}
 */
function isMessageVisible(node) {
    if (typeof node.getBoundingClientRect !== 'function') {
        return true;
    }

    const rect = node.getBoundingClientRect();
    if (!rect.height) {
        return true;
    }

    const chat = document.getElementById('chat');
    const bounds = chat && typeof chat.getBoundingClientRect === 'function'
        ? chat.getBoundingClientRect()
        : null;
    const top = bounds && bounds.height ? bounds.top : 0;
    const bottom = bounds && bounds.height ? bounds.bottom : Infinity;

    return rect.bottom > top && rect.top < bottom;
}

/**
 * Scrolls the chat to a message and rings it for a moment.
 * @param {number} messageId
 * @returns {boolean} true when the message was found in the DOM
 */
function revealMessage(messageId) {
    const node = messageNode(messageId);
    if (!node) {
        return false;
    }

    scrollMessageIntoView(node, true);
    flashMessage(node);
    return true;
}

/**
 * Scrolls to a message and keeps it there until the host stops moving the chat.
 *
 * Opening a chat makes SillyTavern print every message and then scroll to the
 * bottom (and again once the media has loaded). A single `scrollIntoView` right
 * after the switch loses that race, which looks like "it jumped and then snapped
 * back to the newest message". So the scroll is re-asserted until the message has
 * stayed in view across two consecutive checks, or the budget runs out.
 *
 * @param {number} messageId
 * @returns {Promise<boolean>} true once the message is settled in view
 */
async function revealMessageSettled(messageId) {
    let settled = 0;

    for (let attempt = 0; attempt < CHAT_SETTLE_TRIES; attempt++) {
        const node = messageNode(messageId);
        if (!node) {
            settled = 0;
        } else if (isMessageVisible(node)) {
            settled++;
            if (settled >= 2) {
                flashMessage(node);
                return true;
            }
        } else {
            settled = 0;
            scrollMessageIntoView(node, false);
        }

        // eslint-disable-next-line no-await-in-loop -- settling on purpose
        await delay(CHAT_SETTLE_MS);
    }

    return false;
}

/**
 * Shows a host confirmation dialog.
 *
 * Returns `true` when the host has no dialog module, or when it fails: every
 * caller is a deliberate tap, and silently doing nothing is the worse outcome.
 *
 * @param {string} title already translated
 * @param {string} message already translated
 * @param {string} okLabel already translated
 * @returns {Promise<boolean>}
 */
async function confirmWithHost(title, message, okLabel) {
    const module = await loadHostPopupModule();
    const confirm = module && module.Popup && module.Popup.show
        ? module.Popup.show.confirm
        : null;
    if (typeof confirm !== 'function') {
        log('no confirmation dialog available, going ahead');
        return true;
    }

    try {
        const answer = await confirm(title, message, {
            okButton: okLabel,
            cancelButton: translateText('Cancel'),
        });
        return Boolean(answer);
    } catch (error) {
        log('confirmation dialog failed, going ahead', error);
        return true;
    }
}

/**
 * Reads the chat files belonging to a character.
 * @param {{avatar: string, name: string}} identity
 * @returns {Promise<any[]>}
 */
async function listCharacterChats(identity) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
        return [];
    }

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: identity.avatar, ch_name: identity.name }),
    });
    if (!response.ok) {
        throw new Error('listing chats failed: ' + response.status);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

/**
 * Reads one chat file's messages.
 * @param {{avatar: string, name: string}} identity
 * @param {string} fileName
 * @returns {Promise<any[]>}
 */
async function readCharacterChat(identity, fileName) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
        return [];
    }

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: identity.name,
            file_name: fileName,
            avatar_url: identity.avatar,
            allow_not_found: false,
        }),
    });
    if (!response.ok) {
        throw new Error('reading chat failed: ' + response.status);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

/**
 * Sorts a chat listing newest first, when the host gives us a timestamp.
 * @param {any} chat
 * @returns {number}
 */
function chatTimestamp(chat) {
    const raw = chat && (chat.last_mes || chat.last_message_date);
    const parsed = Date.parse(String(raw || ''));
    if (!Number.isNaN(parsed)) {
        return parsed;
    }

    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Shortens `Character - 2024-12-22@12h37m57s.jsonl` to the part worth reading.
 * @param {string} fileName
 * @returns {string}
 */
function chatLabel(fileName) {
    const key = chatFileKey(fileName);
    const dash = key.indexOf(' - ');
    return dash === -1 ? key : key.slice(dash + 3);
}

/**
 * Looks for the media in the character's other chat files.
 *
 * The chat listing is searched newest first and stops at the first hit. The
 * result reports whether the search was exhaustive, because the caller only
 * offers to delete the file when it was: a capped search is not proof that
 * nothing references the image.
 *
 * @param {string} url
 * @returns {Promise<{found: boolean, fileName: string, label: string, searched: number,
 *   complete: boolean, canSearch: boolean}>}
 */
async function searchOtherChats(url) {
    const identity = characterIdentityForMedia(url);
    if (!identity) {
        log('no character to search, skipping the cross-chat search');
        return {
            found: false, fileName: '', label: '', searched: 0,
            complete: false, canSearch: false, identity: null,
        };
    }

    let chats = [];
    try {
        chats = await listCharacterChats(identity);
    } catch (error) {
        log('could not list the character chats', error);
        return {
            found: false, fileName: '', label: '', searched: 0,
            complete: false, canSearch: false, identity,
        };
    }

    const currentKey = chatFileKey(currentChatFile());
    const pending = chats
        .filter((chat) => chat && chat.file_name && chatFileKey(chat.file_name) !== currentKey)
        .sort((a, b) => chatTimestamp(b) - chatTimestamp(a));

    const limit = Math.min(pending.length, CROSS_CHAT_SEARCH_LIMIT);

    for (let index = 0; index < limit; index++) {
        const chat = pending[index];
        let messages = [];
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose
            messages = await readCharacterChat(identity, chat.file_name);
        } catch (error) {
            log('could not read chat', chat.file_name, error);
            continue;
        }

        if (findMessageIdInMessages(messages, url) !== null) {
            return {
                found: true,
                fileName: String(chat.file_name),
                label: chatLabel(chat.file_name),
                searched: index + 1,
                complete: true,
                canSearch: true,
                identity,
            };
        }
    }

    return {
        found: false,
        fileName: '',
        label: '',
        searched: limit,
        complete: limit >= pending.length,
        canSearch: true,
        identity,
    };
}

/**
 * Selects the character a jump targets, when it is not the open one.
 *
 * The gallery can be pointed at another character's folder, and
 * `openCharacterChat()` always works on the character that is currently selected.
 *
 * @param {any} ctx
 * @param {{id: number, avatar: string, name: string}|null} identity
 * @returns {Promise<boolean>}
 */
async function selectCharacterForJump(ctx, identity) {
    if (!identity || Number(ctx.characterId) === identity.id) {
        return true;
    }

    if (typeof ctx.selectCharacterById !== 'function') {
        log('host cannot select another character');
        return false;
    }

    try {
        await ctx.selectCharacterById(identity.id);
        log('selected character', identity.id, 'for the jump');
        return true;
    } catch (error) {
        console.error(DEBUG_PREFIX, 'selecting the image\'s character failed', error);
        return false;
    }
}

/**
 * Closes the windows that would otherwise sit on top of the message we jump to.
 *
 * Switching chats only replaces `#chat`; the gallery and its floating image
 * window live in `#movingDivs` and would stay open over the message, hiding the
 * thing we just jumped to. The gallery is closed through its own close button so
 * the host keeps owning that state (and its wand-button toggle).
 *
 * @param {Element} [control] the jump control we were invoked from
 * @param {boolean} [closeGallery] also close the gallery window
 */
function closeViewerSurfaces(control, closeGallery) {
    const floating = control && typeof control.closest === 'function'
        ? control.closest('.galleryImageDraggable')
        : null;
    if (floating && typeof floating.remove === 'function') {
        floating.remove();
        log('closed the gallery image window');
    }

    if (!closeGallery) {
        return;
    }

    const galleryClose = document.getElementById('galleryclose');
    if (galleryClose && typeof galleryClose.click === 'function') {
        galleryClose.click();
        log('closed the gallery');
    }
}

/**
 * Switches to another chat file and jumps to the message showing the media.
 *
 * When the image belongs to a character other than the open one (the gallery can
 * be pointed anywhere), that character is selected first, because
 * `openCharacterChat()` only ever switches the selected character's chat.
 *
 * @param {string} fileName
 * @param {string} url
 * @param {Element} [control] the jump control, so its windows can be closed
 * @param {{id: number, avatar: string, name: string}|null} identity
 * @returns {Promise<{ok: boolean, switched: boolean, error: Error|null}>}
 */
async function switchToChatAndReveal(fileName, url, control, identity) {
    const ctx = safeContext();
    if (!ctx || typeof ctx.openCharacterChat !== 'function') {
        return { ok: false, switched: false, error: new Error('the host cannot switch chats') };
    }

    if (!(await selectCharacterForJump(ctx, identity))) {
        return { ok: false, switched: false, error: new Error('the host cannot select that character') };
    }

    try {
        await ctx.openCharacterChat(fileName);
    } catch (error) {
        return { ok: false, switched: false, error: error instanceof Error ? error : new Error(String(error)) };
    }

    // The reader is now in another chat, so get the gallery out of the way
    // before scrolling: it would otherwise cover the message.
    closeViewerSurfaces(control, true);

    // Wait for the newly opened chat to render, then hold the scroll until the
    // host is done scrolling to the bottom itself.
    for (let attempt = 0; attempt < CHAT_LOAD_POLL_TRIES; attempt++) {
        const messageId = findMessageIdForMedia(url);
        if (messageId !== null) {
            const settled = await revealMessageSettled(messageId);
            return {
                ok: settled,
                switched: true,
                error: settled ? null : new Error('the message could not be brought into view'),
            };
        }
        // eslint-disable-next-line no-await-in-loop -- polling on purpose
        await delay(CHAT_LOAD_POLL_MS);
    }

    return { ok: false, switched: true, error: new Error('the message was not found in that chat') };
}

/**
 * Builds the served path the delete endpoints expect.
 *
 * The gallery hands out `user/images/...` with no leading slash while the chat
 * stores `/user/images/...`, and `/api/images/delete` keys off that leading slash
 * to pick its route.
 *
 * @param {string} url
 * @returns {string}
 */
function servedDeletePath(url) {
    const value = String(url || '').trim().split('?')[0].split('#')[0];
    if (!value) {
        return '';
    }
    return value.startsWith('/') ? value : '/' + value;
}

/**
 * Nothing references the image any more (or nothing we could read does), so offer
 * to clean up the orphaned file.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
async function offerImageDeletion(url) {
    const target = servedDeletePath(url);
    if (target.indexOf('/user/') !== 0) {
        // Not a local upload: nothing of the host's to delete.
        notify('warning', 'This image is not attached to any message in the current chat.');
        return;
    }

    const confirmed = await confirmWithHost(
        translateText('Image not found'),
        translateText('This image is not in any chat of this character, so the chat it came from may have been deleted. Delete the image from SillyTavern as well? This cannot be undone.'),
        translateText('Delete'),
    );
    if (!confirmed) {
        log('image deletion declined');
        return;
    }

    const deleted = await deleteUploadedFile(target);
    if (deleted) {
        notify('success', 'Image deleted.');
    } else {
        notify('error', 'Could not delete the image.');
    }
}

/**
 * Gallery-only: leaves the viewer for the chat message the image came from.
 *
 * Three steps, cheapest first: the chat that is already open, then the current
 * character's other chat files, and finally the offer to delete an image that
 * nothing references any more.
 *
 * @param {string} src the media URL shown in the gallery viewer
 * @param {Element} [control] the jump control that was pressed
 * @returns {Promise<void>}
 */
async function runJumpToMessage(src, control) {
    const source = String(src || '').trim();
    if (!source) {
        return;
    }

    const here = findMessageIdForMedia(source);
    if (here !== null) {
        const confirmed = await confirmWithHost(
            translateText('Jump to the image'),
            translateText('About to jump to the message this image came from.'),
            translateText('Jump'),
        );
        if (!confirmed) {
            return;
        }

        // Both windows would cover the message we just scrolled to.
        closeViewerSurfaces(control, true);
        if (!revealMessage(here)) {
            notify('warning', 'This image is not attached to any message in the current chat.');
        }
        return;
    }

    notify('info', 'Searching the other chats of this character…');
    const search = await searchOtherChats(source);

    if (search.found) {
        const question = fillPlaceholders(
            translateText('This image is in another chat: ${0}. Switch to it and jump there?'),
            search.label,
        );
        const confirmed = await confirmWithHost(
            translateText('Jump to the image'),
            question,
            translateText('Switch'),
        );
        if (!confirmed) {
            log('chat switch declined');
            return;
        }

        const outcome = await switchToChatAndReveal(search.fileName, source, control, search.identity);
        if (!outcome.ok) {
            if (outcome.switched) {
                notify('warning', 'Switched chats, but the message could not be found.');
            } else {
                const reason = outcome.error && outcome.error.message
                    ? outcome.error.message
                    : String(outcome.error);
                notify('error', 'Could not jump to that chat: ${0}', reason);
            }
        }
        return;
    }

    if (!search.canSearch || !search.complete) {
        if (search.canSearch) {
            notify(
                'warning',
                'Searched the ${0} most recent chats of this character and did not find the image; older chats were not searched.',
                search.searched,
            );
        } else {
            notify('warning', 'This image is not attached to any message in the current chat.');
        }
        return;
    }

    await offerImageDeletion(source);
}

/**
 * Reacts to the two clicks that open the chat image lightbox, and to the click
 * that toggles zoom inside it (which resizes the image under our control).
 */
function installViewerHooks() {
    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!target || typeof target.closest !== 'function') {
            return;
        }

        const opener = target.closest(LIGHTBOX_OPENER_SELECTOR);
        if (opener) {
            refreshViewersSoon();
            return;
        }

        for (const selector of VIEWER_CONTAINER_SELECTORS) {
            const viewer = target.closest(selector);
            if (viewer) {
                repositionViewerSoon(viewer);
                return;
            }
        }
    }, true);

    window.addEventListener('resize', () => {
        for (const selector of VIEWER_CONTAINER_SELECTORS) {
            for (const container of document.querySelectorAll(selector)) {
                repositionViewer(container);
            }
        }
    }, { passive: true });
}

/**
 * Reports whether this device has a touch pointer, so the long press is only
 * armed where it makes sense (a mouse long press would fight text selection).
 * @returns {boolean}
 */
function hasCoarsePointer() {
    try {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: coarse)').matches;
    } catch (error) {
        return false;
    }
}

/**
 * Swallows the click that follows a long press, so the lightbox does not open
 * on top of the confirmation dialog.
 */
function swallowNextClick() {
    const blocker = (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.removeEventListener('click', blocker, true);
    };

    document.addEventListener('click', blocker, true);
    window.setTimeout(() => {
        document.removeEventListener('click', blocker, true);
    }, 800);
}

/**
 * Cached promise for SillyTavern's popup module (`null` when unavailable).
 * @type {Promise<any|null>|null}
 */
let hostPopupPromise = null;

/**
 * Loads the host's dialog module on demand, for the same reason the export
 * module is loaded that way: a plain or older host may not have it, and a static
 * import would take the whole extension down.
 * @returns {Promise<any|null>}
 */
function loadHostPopupModule() {
    if (!hostPopupPromise) {
        hostPopupPromise = import('../../../popup.js')
            .then((module) => (module && module.Popup ? module : null))
            .catch((error) => {
                log('host popup module unavailable', error);
                return null;
            });
    }

    return hostPopupPromise;
}

/**
 * Gives a short buzz so the hold is acknowledged before the dialog appears.
 */
function pulseFeedback() {
    if (typeof navigator.vibrate !== 'function') {
        return;
    }

    try {
        navigator.vibrate(30);
    } catch (error) {
        // Vibration is a nicety; ignore refusals.
    }
}

/**
 * Asks before saving, so a long press cannot fire by accident.
 * @returns {Promise<boolean>}
 */
function confirmDownload() {
    return confirmWithHost(
        translateText('Download image'),
        translateText('Save this image to your device?'),
        translateText('Download'),
    );
}

/**
 * Reports the pixel size of a media element, for the "too small to be content"
 * check. Images and videos expose it under different names.
 * @param {HTMLImageElement|HTMLVideoElement} media
 * @returns {{width: number, height: number}}
 */
function mediaPixelSize(media) {
    const width = Number(media.naturalWidth) || Number(media.videoWidth) || 0;
    const height = Number(media.naturalHeight) || Number(media.videoHeight) || 0;
    return { width, height };
}

/**
 * Arms "hold an image to download it" for the whole document.
 *
 * Delegated from `document` because media comes and goes with every re-render,
 * including inside the lightbox and the gallery. The listeners are always
 * installed; the touch-device check and the setting are evaluated per gesture so
 * both stay effective without re-registering anything.
 */
function installLongPressDownload() {
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let candidate = null;

    const cancel = () => {
        if (timer) {
            window.clearTimeout(timer);
            timer = 0;
        }
        candidate = null;
    };

    const mediaFromTarget = (target) => {
        if (!target || typeof target.closest !== 'function') {
            return null;
        }
        if (target.closest('.mes_img_controls, .mes_img_swipes, .tt-editpaste-viewer-download')) {
            return null;
        }

        const tag = String(target.tagName || '').toUpperCase();
        const media = tag === 'IMG' || tag === 'VIDEO' ? target : target.closest(MEDIA_ELEMENT_SELECTOR);
        if (!media) {
            return null;
        }

        const size = mediaPixelSize(media);
        if (size.width && size.width < LONG_PRESS_MIN_EDGE) {
            return null;
        }
        if (size.height && size.height < LONG_PRESS_MIN_EDGE) {
            return null;
        }

        return media;
    };

    document.addEventListener('touchstart', (event) => {
        cancel();
        if (!getSettings().long_press_download || !hasCoarsePointer()) {
            return;
        }

        const touch = event.touches && event.touches[0];
        if (!touch) {
            return;
        }

        candidate = mediaFromTarget(event.target);
        if (!candidate) {
            return;
        }

        startX = touch.clientX;
        startY = touch.clientY;
        const media = candidate;
        timer = window.setTimeout(() => {
            timer = 0;
            pulseFeedback();
            swallowNextClick();
            confirmDownload().then((confirmed) => {
                if (!confirmed) {
                    log('long press download declined');
                    return null;
                }
                return runDownloadAction(null, mediaSourceForDownload(media));
            }).catch((error) => {
                console.error(DEBUG_PREFIX, 'long press download failed', error);
            });
        }, LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
        const touch = event.touches && event.touches[0];
        if (!touch) {
            cancel();
            return;
        }
        if (Math.abs(touch.clientX - startX) > LONG_PRESS_SLOP_PX
            || Math.abs(touch.clientY - startY) > LONG_PRESS_SLOP_PX) {
            cancel();
        }
    }, { passive: true });

    document.addEventListener('touchend', () => {
        cancel();
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
        cancel();
    }, { passive: true });
}

/**
 * Swaps the control icon: busy while the hand off runs, a short tick on success,
 * and the idle download arrow the rest of the time.
 * @param {Element} control
 * @param {'busy'|'done'|'idle'} state
 */
function markDownloadControl(control, state) {
    const icon = control.querySelector('i') || control;
    icon.classList.remove(DOWNLOAD_ICON_IDLE, DOWNLOAD_ICON_DONE, ...DOWNLOAD_ICON_BUSY);

    if (state === 'busy') {
        icon.classList.add(...DOWNLOAD_ICON_BUSY);
        return;
    }

    if (state === 'done') {
        icon.classList.add(DOWNLOAD_ICON_DONE);
        window.setTimeout(() => {
            icon.classList.remove(DOWNLOAD_ICON_DONE);
            icon.classList.add(DOWNLOAD_ICON_IDLE);
        }, 1200);
        return;
    }

    icon.classList.add(DOWNLOAD_ICON_IDLE);
}

/* ------------------------------------------------------------------ */
/* collapsible images and media                                        */
/* ------------------------------------------------------------------ */

/**
 * The collapse bar, the eye switch and the "left behind" bookkeeping.
 *
 * Rewritten from the 1.14.1 baseline. The three rules below are the whole design;
 * everything in this section exists to keep them true.
 *
 * 1. One source of truth per question.
 *    "Is this picture folded?"      -> MEDIA_STATE, a map of picture key to truth.
 *    "Does this picture go out?"    -> the chat metadata, under one field.
 *    The DOM only mirrors those answers so CSS can act on them. Nothing reads a
 *    data attribute back as state: a redrawn element loses its attributes, and the
 *    old code took that silence for "send", which is why a dimmed eye grew bright
 *    again after an edit, a delete or a whole-chat fold.
 *
 * 2. The key names the picture, never its slot.
 *    A chat picture is keyed by its served path (plus host, when the host is not
 *    ours) or, for embedded bytes, by a hash of the data URL. None of that changes
 *    when the host renumbers data-index, rebuilds a container or re-renders a
 *    message, so the eye keeps its meaning through all of it.
 *
 * 3. Folding is cosmetic.
 *    Only a click on the eye changes what is sent. Redraw, renumber, "fold all"
 *    and "unfold all" may never touch the eye.
 */

/** Metadata field under MODULE_NAME that holds the switched-off pictures. */
const MEDIA_META_FIELD = 'withheld_pictures';

/** Attribute the bars stamp on their target, so CSS can hide everything else. */
const MEDIA_STATE_ATTR = 'data-tt-editpaste-collapsed';

/** Fold state, keyed by picture key. Cosmetic; never written to the chat file. */
const MEDIA_STATE = new Map();

/**
 * Pictures switched off while the chat metadata is not reachable yet (the client
 * is still booting). Kept in memory only for that window, then folded into the
 * metadata by the next write.
 */
const MEMORY_SEND = new Set();

/** Fold state remembered per element, so a gallery swipe does not re-fold. */
const TARGET_FOLD = new WeakMap();

/** Last thing painted into a bar, so an idle sync pass writes nothing. */
const BAR_PAINT = new WeakMap();

/** Picture keys we already resolved to a base64 prefix (or failed to). */
const PICTURE_SIGNATURE_CACHE = new Map();

/** How many leading bytes of an embedded picture are enough to recognise it. */
const SIGNATURE_BYTES = 96;

/** Bail out of a signature download after this long (ms). */
const SIGNATURE_TIMEOUT_MS = 800;

/** The containers and media items that can carry a bar. */
const COLLAPSE_CONTAINER_SELECTOR = '.mes_media_container';
const COLLAPSE_MEDIA_SELECTOR = '.mes_media_wrapper img, .mes_media_wrapper video, .mes_text img, .mes_text video';

/**
 * Host chrome that must never become a target: the hover buttons and swipe arrows
 * belong to the host's own media viewer, and our own bar and notice are ours.
 */
const COLLAPSE_SKIP_SELECTOR = '.mes_img_controls, .mes_img_swipes, .avatar, .mes_avatar_wrapper, .' + MEDIA_BAR_CLASS + ', .tt-editpaste-notice';

/** Payload lists that can carry pictures in a Chat Completion request. */
const PAYLOAD_LIST_NAMES = ['prompt', 'messages', 'chat'];

/** Markdown and HTML forms a picture takes inside a plain text prompt. */
const PICTURE_MARKUP_PATTERNS = [
    /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g,
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
];

/** Installed once; the host keeps the handlers for the whole session. */
let promptFilterInstalled = false;

/** The summary line already shown for this turn, so a double hook cannot repeat it. */
let outgoingLine = null;

/* ------------------------------------------------------------------ */
/* keys: what a picture is called                                      */
/* ------------------------------------------------------------------ */

/** Where the client is served from, without a trailing slash. */
function currentOrigin() {
    try {
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
            return String(window.location.origin).replace(/\/+$/, '');
        }
    } catch (error) {
        return '';
    }
    return '';
}

/** The host part of an absolute URL, lower case, including a port. */
function hostOfUrl(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url || ''));
    return match ? match[1].toLowerCase() : '';
}

/** Whether a URL carries its own scheme ("/user/x.png" does not). */
function isAbsoluteUrl(url) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url || ''));
}

/**
 * A short, stable fingerprint for bytes we only have inline.
 * FNV-1a over the first 512 characters, plus the total length.
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
    const value = String(text);
    const sample = value.length > 512 ? value.slice(0, 512) : value;
    let hash = 2166136261;
    for (let i = 0; i < sample.length; i += 1) {
        hash ^= sample.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return value.length.toString(36) + '-' + hash.toString(36);
}

/**
 * The key a picture is stored under: its path for a served file, host plus path
 * for a file served by someone else, a hash for inline bytes.
 * @param {string} url
 * @returns {string}
 */
function sendKeyForUrl(url) {
    const raw = String(url === null || url === undefined ? '' : url).trim();
    if (!raw) {
        return '';
    }
    if (raw.indexOf('data:') === 0) {
        return 'bytes#' + hashText(raw);
    }
    const path = mediaPathKey(raw);
    if (!path) {
        return '';
    }
    const host = hostOfUrl(raw);
    const ownHost = hostOfUrl(currentOrigin());
    if (host && host !== ownHost) {
        // Two sites can both serve "/same.png"; the host keeps them apart.
        return host + '/' + path;
    }
    return path;
}

/** The src a media element actually points at, including lazily loaded ones. */
function mediaSourceUrl(media) {
    if (!media) {
        return '';
    }
    const names = ['src', 'data-src', 'data-original', 'data-url'];
    for (let i = 0; i < names.length; i += 1) {
        const value = media.getAttribute(names[i]);
        if (value) {
            return value;
        }
    }
    const source = typeof media.querySelector === 'function' ? media.querySelector('source') : null;
    if (source) {
        const value = source.getAttribute('src');
        if (value) {
            return value;
        }
    }
    return '';
}

/** Every image or video a collapse target stands for. */
function mediaElementsFor(target) {
    if (!target) {
        return [];
    }
    if (target.tagName === 'IMG' || target.tagName === 'VIDEO') {
        return [target];
    }
    if (typeof target.querySelectorAll !== 'function') {
        return [];
    }
    return Array.prototype.slice.call(target.querySelectorAll(MEDIA_ELEMENT_SELECTOR));
}

/** The key of the first picture inside a target, or an empty string. */
function mediaKeyFor(target) {
    const media = mediaElementsFor(target);
    if (media.length === 0) {
        return '';
    }
    return sendKeyForUrl(mediaSourceUrl(media[0]));
}

/** Every distinct key the pictures inside a target answer to. */
function targetKeys(target) {
    const keys = [];
    const media = mediaElementsFor(target);
    for (let i = 0; i < media.length; i += 1) {
        const key = sendKeyForUrl(mediaSourceUrl(media[i]));
        if (key && keys.indexOf(key) === -1) {
            keys.push(key);
        }
    }
    return keys;
}

/* ------------------------------------------------------------------ */
/* fold state: cosmetic, per picture, remembered per element           */
/* ------------------------------------------------------------------ */

/** Whether a fresh picture starts folded. It does: the chat stays quiet. */
function isFolded(key) {
    if (!key) {
        return true;
    }
    if (MEDIA_STATE.has(key)) {
        return MEDIA_STATE.get(key) === true;
    }
    return true;
}

/** Remember a fold choice for the picture, so a rebuilt element reseeds from it. */
function setFoldedKey(key, folded) {
    if (!key) {
        return;
    }
    MEDIA_STATE.set(key, folded === true);
}

/**
 * The fold state of one target element.
 *
 * The element remembers its own answer while it lives, so a gallery swipe that
 * swaps the picture under it does not fold the new one. A rebuilt element has no
 * memory and reseeds from MEDIA_STATE, which is what makes an unfold survive the
 * host re-rendering the message.
 */
function foldFor(target) {
    if (TARGET_FOLD.has(target)) {
        return TARGET_FOLD.get(target) === true;
    }
    const folded = isFolded(mediaKeyFor(target));
    TARGET_FOLD.set(target, folded);
    return folded;
}

/** Fold one target and remember the choice for its picture as well. */
function setFoldFor(target, folded) {
    TARGET_FOLD.set(target, folded === true);
    setFoldedKey(mediaKeyFor(target), folded);
}

/**
 * Drop the in-memory eyes on a chat switch.
 *
 * Fold choices are keyed by the picture itself and stay: unfolding a picture and
 * then switching chats and back should not fold it again. The eyes cannot be kept
 * that way, because they belong to one chat file, so anything that only lived in
 * memory (the chat metadata was not reachable) is dropped here.
 */
function resetSendMemory() {
    MEMORY_SEND.clear();
}

/* ------------------------------------------------------------------ */
/* send state: the chat metadata is the only truth                     */
/* ------------------------------------------------------------------ */

/**
 * The box holding switched-off pictures, or null when the client has no chat
 * metadata yet. Only a write creates it: reading a chat must not add empty
 * fields to it, and must not hand back a box from another chat.
 * @param {boolean} create
 */
function withheldBox(create) {
    const ctx = safeContext();
    if (!ctx || !ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') {
        return null;
    }
    let mine = ctx.chatMetadata[MODULE_NAME];
    if (!mine || typeof mine !== 'object' || Array.isArray(mine)) {
        if (!create) {
            return null;
        }
        mine = {};
        ctx.chatMetadata[MODULE_NAME] = mine;
    }
    let box = mine[MEDIA_META_FIELD];
    if (!box || typeof box !== 'object' || Array.isArray(box)) {
        if (!create) {
            return null;
        }
        box = {};
        mine[MEDIA_META_FIELD] = box;
    }
    return box;
}

/** Own-property test that survives a key like "constructor". */
function hasOwnEntry(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

/** Every picture the user switched off in this chat. */
function withheldKeys() {
    const keys = new Set();
    const box = withheldBox(false);
    if (box) {
        const names = Object.keys(box);
        for (let i = 0; i < names.length; i += 1) {
            if (box[names[i]]) {
                keys.add(names[i]);
            }
        }
    }
    // Pictures switched off before the metadata was reachable are still off.
    for (const key of MEMORY_SEND) {
        keys.add(key);
    }
    return keys;
}

/** Whether one picture is switched off. */
function isWithheldKey(key) {
    if (!key) {
        return false;
    }
    const box = withheldBox(false);
    if (box && hasOwnEntry(box, key) && box[key]) {
        return true;
    }
    return MEMORY_SEND.has(key);
}

/**
 * Switch one picture on or off, and say whether anything changed.
 * @param {string} key
 * @param {boolean} withheld
 * @returns {boolean}
 */
function setWithheldKey(key, withheld) {
    if (!key) {
        return false;
    }
    const box = withheldBox(true);
    if (!box) {
        const had = MEMORY_SEND.has(key);
        if (had === withheld) {
            return false;
        }
        if (withheld) {
            MEMORY_SEND.add(key);
        } else {
            MEMORY_SEND.delete(key);
        }
        return true;
    }
    const had = hasOwnEntry(box, key) && Boolean(box[key]);
    if (had === withheld) {
        MEMORY_SEND.delete(key);
        return false;
    }
    if (withheld) {
        box[key] = 1;
    } else {
        delete box[key];
    }
    MEMORY_SEND.delete(key);
    return true;
}

/** Set to true the first time the host fallback was tried; the import runs once. */
let METADATA_SAVE_TRIED = false;

/**
 * Ask the host to flush the chat metadata.
 *
 * The mutation above is what actually persists: the host writes the whole
 * chat_metadata object on its next chat save. This nudges it to happen now, and
 * falls back to the host module when the context does not expose the helpers.
 */
function saveChatMetadata() {
    const ctx = safeContext();
    if (ctx) {
        try {
            if (typeof ctx.saveMetadataDebounced === 'function') {
                ctx.saveMetadataDebounced();
                return;
            }
            if (typeof ctx.saveMetadata === 'function') {
                ctx.saveMetadata();
                return;
            }
        } catch (error) {
            log('saving the chat metadata failed', error);
            return;
        }
    }
    if (METADATA_SAVE_TRIED) {
        return;
    }
    METADATA_SAVE_TRIED = true;
    import('../../../script.js')
        .then((host) => {
            if (typeof host.saveMetadata === 'function') {
                host.saveMetadata();
            } else if (typeof host.saveMetadataDebounced === 'function') {
                host.saveMetadataDebounced();
            } else {
                log('no chat metadata save helper found; the eye choices reach the chat file with the next chat save');
            }
        })
        .catch(() => log('no chat metadata save helper found; the eye choices reach the chat file with the next chat save'));
}

/**
 * Whether every picture inside a target is switched off.
 * A target holding several pictures counts as off only when all of them are off,
 * so a mixed album still shows a bright eye and still sends something.
 */
function targetIsWithheld(target, keys) {
    const list = targetKeys(target);
    if (list.length === 0) {
        return false;
    }
    for (let i = 0; i < list.length; i += 1) {
        if (!keys.has(list[i])) {
            return false;
        }
    }
    return true;
}

/** Switch every picture of a target on or off. */
function toggleTargetSend(target) {
    const list = targetKeys(target);
    if (list.length === 0) {
        log('this media item has no picture URL, so the eye cannot remember it');
        return;
    }
    const keys = withheldKeys();
    const next = !targetIsWithheld(target, keys);
    for (let i = 0; i < list.length; i += 1) {
        setWithheldKey(list[i], next);
    }
    saveChatMetadata();
    log(next ? 'switched off' : 'switched back on', list.join(', '));
    // Repaint now instead of waiting for the next sync tick: the whole chat may
    // hold the same picture more than once, and all copies should agree at once.
    enhanceMediaCollapse();
}

/* ------------------------------------------------------------------ */
/* the bar                                                             */
/* ------------------------------------------------------------------ */

/** The target a bar belongs to: whatever sits right behind it. */
function isCollapseTarget(element) {
    if (!element || !element.tagName) {
        return false;
    }
    if (element.tagName === 'IMG' || element.tagName === 'VIDEO') {
        return true;
    }
    if (element.classList && element.classList.contains('mes_media_container')) {
        return true;
    }
    if (element.tagName === 'A') {
        return Boolean(element.querySelector(MEDIA_ELEMENT_SELECTOR));
    }
    return false;
}

/**
 * Resolve the bar's picture at event time, never by closing over the element that
 * happened to be there when the bar was built. The host replaces media in place,
 * and a captured element would then fold the picture that used to be there.
 */
function barTarget(bar) {
    const next = bar ? bar.nextElementSibling : null;
    return isCollapseTarget(next) ? next : null;
}

/** The bar that already sits right before a target, if any. */
function mediaBarFor(target) {
    if (!target || !target.parentElement) {
        return null;
    }
    // previousElementSibling, never parent.children[index]: an HTMLCollection has
    // no indexOf, and doing that here once killed the whole reconciler silently.
    const previous = target.previousElementSibling;
    if (!previous || !previous.classList || !previous.classList.contains(MEDIA_BAR_CLASS)) {
        return null;
    }
    return previous;
}

function stopEvent(event) {
    if (!event) {
        return;
    }
    if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
    }
    if (typeof event.preventDefault === 'function') {
        event.preventDefault();
    }
}

function isActivationKey(event) {
    if (!event || !event.key) {
        return false;
    }
    return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}

/** Mirror the state onto the target so CSS can hide everything but the bar. */
function applyTargetMirror(target, folded, withheld) {
    const foldValue = folded ? '1' : '0';
    if (target.getAttribute(MEDIA_STATE_ATTR) !== foldValue) {
        target.setAttribute(MEDIA_STATE_ATTR, foldValue);
    }
    if (target.classList.contains(MEDIA_COLLAPSED_CLASS) !== folded) {
        target.classList.toggle(MEDIA_COLLAPSED_CLASS, folded);
    }
    const sendValue = withheld ? '0' : '1';
    if (target.getAttribute(MEDIA_SEND_ATTR) !== sendValue) {
        target.setAttribute(MEDIA_SEND_ATTR, sendValue);
    }
}

/** Paint the eye: bright means the picture goes out, dim means it stays behind. */
function paintEye(eye, withheld) {
    if (!eye) {
        return;
    }
    const icon = eye.querySelector('i') || eye;
    icon.classList.toggle(MEDIA_SEND_ON_ICON, !withheld);
    icon.classList.toggle(MEDIA_SEND_OFF_ICON, withheld);
    eye.classList.toggle(MEDIA_SEND_DIM_CLASS, withheld);
    eye.setAttribute('aria-pressed', withheld ? 'false' : 'true');
    const title = withheld
        ? translateText('Left out of the message, click to send it')
        : translateText('Sent with the message, click to leave it out');
    if (eye.title !== title) {
        eye.title = title;
    }
    eye.setAttribute('aria-label', title);
}

/** Paint one bar from the current state, skipping the work when nothing changed. */
function paintBar(bar, target, keys) {
    if (!bar || !target) {
        return;
    }
    const key = mediaKeyFor(target);
    if (key && bar.getAttribute(MEDIA_BAR_FOR_ATTR) !== key) {
        bar.setAttribute(MEDIA_BAR_FOR_ATTR, key);
    }
    const folded = foldFor(target);
    const withheld = targetIsWithheld(target, keys);
    applyTargetMirror(target, folded, withheld);
    const signature = (folded ? 'f' : 'u') + (withheld ? 'w' : 's') + ':' + key;
    if (BAR_PAINT.get(bar) === signature) {
        return;
    }
    BAR_PAINT.set(bar, signature);
    const icon = bar.querySelector('.' + MEDIA_BAR_ICON_CLASS);
    if (icon) {
        icon.classList.toggle('fa-caret-right', folded);
        icon.classList.toggle('fa-caret-down', !folded);
    }
    const text = bar.querySelector('.' + MEDIA_BAR_TEXT_CLASS);
    const label = folded
        ? translateText('Collapsed media, click to expand')
        : translateText('Media, click to collapse');
    if (text && text.textContent !== label) {
        text.textContent = label;
    }
    if (bar.title !== label) {
        bar.title = label;
    }
    paintEye(bar.querySelector('.' + MEDIA_SEND_CLASS), withheld);
}

/**
 * Build one bar. Handlers are attached here, once; they look their target up when
 * they run, so nothing goes stale when the host replaces the media behind a bar.
 */
function createBar() {
    const bar = document.createElement('span');
    bar.className = MEDIA_BAR_CLASS;
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');

    const icon = document.createElement('span');
    icon.className = 'fa-solid fa-caret-right ' + MEDIA_BAR_ICON_CLASS;

    const text = document.createElement('span');
    text.className = MEDIA_BAR_TEXT_CLASS;

    const eye = document.createElement('span');
    eye.className = MEDIA_SEND_CLASS;
    eye.setAttribute('role', 'button');
    eye.setAttribute('tabindex', '0');

    const eyeIcon = document.createElement('i');
    eyeIcon.className = 'fa-solid ' + MEDIA_SEND_ON_ICON;
    eye.appendChild(eyeIcon);

    bar.appendChild(icon);
    bar.appendChild(text);
    bar.appendChild(eye);

    const fold = (event) => {
        const target = barTarget(bar);
        if (!target) {
            return;
        }
        stopEvent(event);
        setFoldFor(target, !foldFor(target));
        paintBar(bar, target, withheldKeys());
    };

    bar.addEventListener('click', fold);
    bar.addEventListener('keydown', (event) => {
        if (isActivationKey(event)) {
            fold(event);
        }
    });

    const switchSend = (event) => {
        const target = barTarget(bar);
        if (!target) {
            return;
        }
        // The eye sits inside the bar; without this, the same click would fold too.
        stopEvent(event);
        toggleTargetSend(target);
    };

    eye.addEventListener('click', switchSend);
    eye.addEventListener('keydown', (event) => {
        if (isActivationKey(event)) {
            switchSend(event);
        }
    });

    return bar;
}

/** Make sure a target has exactly one bar right before it, and hand it back. */
function ensureBar(target) {
    if (!target || !target.parentElement) {
        return null;
    }
    const existing = mediaBarFor(target);
    if (existing) {
        return existing;
    }
    const bar = createBar();
    target.parentElement.insertBefore(bar, target);
    return bar;
}

/** Drop bars whose target is gone: they would keep floating above nothing. */
function pruneOrphanBars(live) {
    if (typeof document === 'undefined' || !document.body) {
        return;
    }
    const bars = document.querySelectorAll('.' + MEDIA_BAR_CLASS);
    for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        const next = bar.nextElementSibling;
        if (next && (live.has(next) || isCollapseTarget(next))) {
            continue;
        }
        bar.remove();
    }
}

/** Strip every bar and every mirror attribute; used when the feature is turned off. */
function removeMediaBars() {
    if (typeof document === 'undefined' || !document.body) {
        return;
    }
    const bars = document.querySelectorAll('.' + MEDIA_BAR_CLASS);
    for (let i = 0; i < bars.length; i += 1) {
        bars[i].remove();
    }
    const folded = document.querySelectorAll('[' + MEDIA_STATE_ATTR + ']');
    for (let j = 0; j < folded.length; j += 1) {
        folded[j].removeAttribute(MEDIA_STATE_ATTR);
        folded[j].classList.remove(MEDIA_COLLAPSED_CLASS);
    }
    const marked = document.querySelectorAll('[' + MEDIA_SEND_ATTR + ']');
    for (let k = 0; k < marked.length; k += 1) {
        marked[k].removeAttribute(MEDIA_SEND_ATTR);
    }
}

/* ------------------------------------------------------------------ */
/* finding what to decorate                                            */
/* ------------------------------------------------------------------ */

/**
 * The element a picture is folded as: the media itself, or the link wrapping it
 * when that link holds nothing else.
 */
function collapseTargetFor(media) {
    const parent = media.parentElement;
    if (parent && parent.tagName === 'A' && parent.querySelectorAll(MEDIA_ELEMENT_SELECTOR).length === 1) {
        return parent;
    }
    return media;
}

/**
 * Every media holder in the chat that deserves a bar.
 *
 * Containers come first so an album folds as one unit; the loose pictures second,
 * which covers images written into the message text. Empty containers are skipped:
 * a media slot the host left behind is not a picture, and counting it would make
 * the summary claim images that are not there.
 */
function collectCollapseTargets() {
    const targets = [];
    if (typeof document === 'undefined' || !document.body) {
        return targets;
    }
    const add = (candidate) => {
        if (!candidate || !candidate.parentElement) {
            return;
        }
        for (let i = 0; i < targets.length; i += 1) {
            if (targets[i] === candidate || targets[i].contains(candidate)) {
                return;
            }
        }
        targets.push(candidate);
    };

    const containers = document.querySelectorAll(COLLAPSE_CONTAINER_SELECTOR);
    for (let i = 0; i < containers.length; i += 1) {
        const container = containers[i];
        if (container.closest && container.closest(COLLAPSE_SKIP_SELECTOR)) {
            continue;
        }
        if (container.querySelectorAll(MEDIA_ELEMENT_SELECTOR).length === 0) {
            continue;
        }
        add(container);
    }

    const media = document.querySelectorAll(COLLAPSE_MEDIA_SELECTOR);
    for (let j = 0; j < media.length; j += 1) {
        const element = media[j];
        if (element.closest && element.closest(COLLAPSE_SKIP_SELECTOR)) {
            continue;
        }
        add(collapseTargetFor(element));
    }
    return targets;
}

/** How many pictures those targets hold, which is what the user counts. */
function countMediaItems(targets) {
    let total = 0;
    for (let i = 0; i < targets.length; i += 1) {
        total += mediaElementsFor(targets[i]).length;
    }
    return total;
}

/** How many pictures are still switched on. */
function countOpenPictures(targets) {
    const keys = withheldKeys();
    let total = 0;
    for (let i = 0; i < targets.length; i += 1) {
        const list = targetKeys(targets[i]);
        for (let j = 0; j < list.length; j += 1) {
            if (!keys.has(list[j])) {
                total += 1;
            }
        }
    }
    return total;
}

/* ------------------------------------------------------------------ */
/* the sync pass                                                       */
/* ------------------------------------------------------------------ */

/**
 * Bring the bars in line with the state. Runs from the 500 ms sync tick and from
 * the settings checkbox, so it has to be cheap and idempotent: a pass that finds
 * nothing to change writes nothing.
 */
function enhanceMediaCollapse() {
    if (!getSettings().collapse_media_bars) {
        removeMediaBars();
        return { enabled: false, targets: 0, bars: 0 };
    }
    if (typeof document === 'undefined' || !document.body) {
        return { enabled: true, targets: 0, bars: 0 };
    }
    // One metadata read per pass, so every bar in this chat agrees with itself.
    const keys = withheldKeys();
    const targets = collectCollapseTargets();
    const live = new Set(targets);
    let bars = 0;
    for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const bar = ensureBar(target);
        if (!bar) {
            continue;
        }
        bars += 1;
        paintBar(bar, target, keys);
    }
    pruneOrphanBars(live);
    return { enabled: true, targets: targets.length, bars };
}

/** A snapshot for the console (and for bug reports). */
function mediaCollapseReport() {
    const enabled = Boolean(getSettings().collapse_media_bars);
    const targets = collectCollapseTargets();
    let bars = 0;
    let folded = 0;
    let messages = 0;
    let textImages = 0;
    const seenMessages = new Set();
    if (typeof document !== 'undefined' && document.body) {
        bars = document.querySelectorAll('.' + MEDIA_BAR_CLASS).length;
    }
    for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        if (foldFor(target)) {
            folded += 1;
        }
        const message = target.closest ? target.closest('.mes') : null;
        if (message) {
            const mesid = message.getAttribute('mesid');
            if (mesid !== null && !seenMessages.has(mesid)) {
                seenMessages.add(mesid);
                messages += 1;
            }
        }
        if (target.closest && target.closest('.mes_text')) {
            textImages += 1;
        }
    }
    const wrappers = document.querySelectorAll('.mes_media_wrapper').length;
    const containers = document.querySelectorAll(COLLAPSE_CONTAINER_SELECTOR).length;
    const wandEntry = Boolean(document.getElementById(WAND_ENTRY_ID));
    return {
        enabled,
        targets: targets.length,
        bars,
        folded,
        messages,
        wrappers,
        containers,
        textImages,
        wandEntry,
        withheld: withheldKeys().size,
        open: countOpenPictures(targets),
    };
}

/* ------------------------------------------------------------------ */
/* the wand menu entry                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fold or unfold the whole chat. Folding is cosmetic, so this deliberately never
 * looks at, or writes, the eyes: a "fold all" that lit every eye is exactly the
 * behaviour this rewrite exists to remove.
 */
function toggleAllMedia() {
    const settings = getSettings();
    if (!settings.collapse_media_bars) {
        settings.collapse_media_bars = true;
        const input = document.getElementById('tt_editpaste_collapse_media');
        if (input) {
            input.checked = true;
        }
        const ctx = safeContext();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }
    enhanceMediaCollapse();
    const targets = collectCollapseTargets();
    if (targets.length === 0) {
        log('no media to fold in this chat');
        return { count: 0, targets: 0, collapsed: false };
    }
    let foldedCount = 0;
    for (let i = 0; i < targets.length; i += 1) {
        if (foldFor(targets[i])) {
            foldedCount += 1;
        }
    }
    // Anything still unfolded means "fold them all"; a fully folded chat unfolds.
    const collapse = foldedCount < targets.length;
    for (let j = 0; j < targets.length; j += 1) {
        setFoldFor(targets[j], collapse);
    }
    enhanceMediaCollapse();
    const count = countMediaItems(targets);
    log((collapse ? 'folded ' : 'unfolded ') + count + ' image/media item(s)');
    if (count > 0) {
        notify('success', collapse ? 'Folded ${0} image(s).' : 'Unfolded ${0} image(s).', count);
    }
    return { count, targets: targets.length, collapsed: collapse };
}

/** Add this extension's entry to the wand menu, right after the gallery's slot. */
function installWandEntry() {
    if (typeof document === 'undefined' || !document.body) {
        return false;
    }
    if (document.getElementById(WAND_ENTRY_ID)) {
        return true;
    }
    const menu = document.getElementById('extensionsMenu');
    const gallerySlot = document.getElementById('gallery_wand_container');
    if (!menu && !gallerySlot) {
        return false;
    }
    const label = translateText('Unfold / fold all images');

    const entry = document.createElement('div');
    entry.id = WAND_ENTRY_ID;
    entry.className = 'list-group-item flex-container flexGap5';
    entry.setAttribute('role', 'button');
    entry.setAttribute('tabindex', '0');
    entry.title = label;
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-compress extensionsMenuExtensionButton';
    const text = document.createElement('span');
    text.textContent = label;
    entry.appendChild(icon);
    entry.appendChild(text);

    const activate = (event) => {
        stopEvent(event);
        toggleAllMedia();
    };
    entry.addEventListener('click', activate);
    entry.addEventListener('keydown', (event) => {
        if (isActivationKey(event)) {
            activate(event);
        }
    });

    const host = menu || (gallerySlot ? gallerySlot.parentElement : null);
    if (!host) {
        return false;
    }
    const slot = document.createElement('div');
    slot.id = WAND_SLOT_ID;
    slot.className = 'extension_container';
    slot.appendChild(entry);
    if (gallerySlot && gallerySlot.parentElement === host) {
        host.insertBefore(slot, gallerySlot.nextSibling);
    } else {
        host.appendChild(slot);
    }
    return true;
}

/** The wand menu is rebuilt by the host; keep putting our entry back. */
function installWandEntryHooks() {
    document.addEventListener('click', () => {
        installWandEntry();
    }, true);
    if (!installWandEntry()) {
        window.setTimeout(installWandEntry, 0);
    }
}

/* ------------------------------------------------------------------ */
/* keeping switched-off pictures out of the prompt                     */
/* ------------------------------------------------------------------ */

/** How many pictures a piece of plain text shows. */
function countPictureMarkup(text) {
    const value = String(text || '');
    let total = 0;
    for (let i = 0; i < PICTURE_MARKUP_PATTERNS.length; i += 1) {
        const pattern = PICTURE_MARKUP_PATTERNS[i];
        pattern.lastIndex = 0;
        let match = pattern.exec(value);
        while (match) {
            total += 1;
            match = pattern.exec(value);
        }
        pattern.lastIndex = 0;
    }
    return total;
}

/**
 * Remove the switched-off pictures from a piece of text.
 * @returns {string|null} the new text, or null when nothing was switched off.
 */
function stripWithheldMarkup(text, keys) {
    const value = String(text || '');
    if (!value || keys.size === 0) {
        return null;
    }
    let result = value;
    let removed = 0;
    for (let i = 0; i < PICTURE_MARKUP_PATTERNS.length; i += 1) {
        const pattern = PICTURE_MARKUP_PATTERNS[i];
        pattern.lastIndex = 0;
        result = result.replace(pattern, (match, url) => {
            const key = sendKeyForUrl(url);
            if (!key || !keys.has(key)) {
                return match;
            }
            removed += 1;
            return '';
        });
        pattern.lastIndex = 0;
    }
    return removed > 0 ? result : null;
}

/** The URL and the inline bytes a content block shows, if it shows a picture. */
function pictureBlockRef(block) {
    if (!block || typeof block !== 'object') {
        return null;
    }
    const type = String(block.type || '');
    const looksLikePicture = type.indexOf('image') === 0 || type === 'input_image' || type === 'media' || Boolean(block.inline_data);
    if (!looksLikePicture) {
        return null;
    }
    const ref = { url: '', base64: '' };
    const imageUrl = block.image_url || block.imageUrl;
    if (typeof imageUrl === 'string') {
        ref.url = imageUrl;
    } else if (imageUrl && typeof imageUrl === 'object' && typeof imageUrl.url === 'string') {
        ref.url = imageUrl.url;
    }
    if (!ref.url && typeof block.url === 'string') {
        ref.url = block.url;
    }
    if (ref.url.indexOf('data:') === 0) {
        ref.base64 = dataUrlBase64(ref.url);
        ref.url = '';
    }
    if (!ref.base64 && block.source && typeof block.source.data === 'string') {
        ref.base64 = block.source.data;
    }
    if (!ref.base64 && block.inline_data && typeof block.inline_data.data === 'string') {
        ref.base64 = block.inline_data.data;
    }
    if (!ref.base64 && typeof block.data === 'string') {
        ref.base64 = block.data;
    }
    if (!ref.url && !ref.base64) {
        return null;
    }
    return ref;
}

/** The base64 payload of a data URL. */
function dataUrlBase64(url) {
    const value = String(url || '');
    const comma = value.indexOf(',');
    if (comma === -1) {
        return '';
    }
    return value.slice(comma + 1);
}

/** Whether a content block shows a picture the user switched off. */
function blockIsWithheld(ref, keys, allowBytes) {
    if (!ref) {
        return false;
    }
    if (ref.url) {
        const key = sendKeyForUrl(ref.url);
        if (key && keys.has(key)) {
            return true;
        }
    }
    if (allowBytes && ref.base64) {
        return base64LooksWithheld(ref.base64, keys);
    }
    return false;
}

/** The URL a media entry points at: the host sends objects, but strings exist too. */
function mediaEntryUrl(entry) {
    if (typeof entry === 'string') {
        return entry;
    }
    if (!entry || typeof entry !== 'object') {
        return '';
    }
    if (typeof entry.url === 'string') {
        return entry.url;
    }
    if (typeof entry.path === 'string') {
        return entry.path;
    }
    return '';
}

/** Whether one entry of a record's media list is switched off. */
function mediaEntryIsWithheld(entry, keys, allowBytes) {
    const url = mediaEntryUrl(entry);
    if (!url) {
        return false;
    }
    if (url.indexOf('data:') === 0) {
        const key = sendKeyForUrl(url);
        if (key && keys.has(key)) {
            return true;
        }
        if (allowBytes) {
            return base64LooksWithheld(dataUrlBase64(url), keys);
        }
        return false;
    }
    const key = sendKeyForUrl(url);
    if (key && keys.has(key)) {
        return true;
    }
    if (allowBytes && entry && typeof entry === 'object') {
        const bytes = typeof entry.data === 'string' ? entry.data : (typeof entry.base64 === 'string' ? entry.base64 : '');
        if (bytes) {
            return base64LooksWithheld(bytes, keys);
        }
    }
    return false;
}

/** Whether inline bytes belong to a picture the user switched off. */
function base64LooksWithheld(base64, keys) {
    if (!base64 || keys.size === 0) {
        return false;
    }
    for (const key of keys) {
        const signature = PICTURE_SIGNATURE_CACHE.get(key);
        if (signature && base64.indexOf(signature) === 0) {
            return true;
        }
    }
    return false;
}

/**
 * Load the leading bytes of a served picture, so an inlined copy of it can be
 * recognised. Best effort: a failure just means that copy stays in the prompt.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
function loadBase64Prefix(key) {
    const url = '/' + String(key || '').replace(/^\/+/, '');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = window.setTimeout(() => {
        if (controller) {
            controller.abort();
        }
    }, SIGNATURE_TIMEOUT_MS);
    const request = { method: 'GET' };
    if (controller) {
        request.signal = controller.signal;
    }
    return fetch(url, request)
        .then((response) => {
            if (!response || !response.ok || typeof response.arrayBuffer !== 'function') {
                return null;
            }
            return response.arrayBuffer();
        })
        .then((buffer) => {
            if (!buffer) {
                return null;
            }
            const bytes = new Uint8Array(buffer);
            const take = Math.min(bytes.length, SIGNATURE_BYTES);
            let binary = '';
            for (let i = 0; i < take; i += 1) {
                binary += String.fromCharCode(bytes[i]);
            }
            // The payload is base64, so the probe has to end on a character boundary.
            while (binary.length > 0 && binary.length % 3 !== 0) {
                binary = binary.slice(0, -1);
            }
            return binary ? btoa(binary) : null;
        })
        .catch(() => null)
        .then((signature) => {
            window.clearTimeout(timer);
            return signature;
        });
}

/** Resolve the signatures of the given keys, caching both hits and misses. */
function ensureSignatures(keys) {
    const wanted = [];
    for (const key of keys) {
        if (!PICTURE_SIGNATURE_CACHE.has(key)) {
            wanted.push(key);
        }
    }
    if (wanted.length === 0) {
        return Promise.resolve();
    }
    return Promise.all(wanted.map((key) => loadBase64Prefix(key))).then((signatures) => {
        for (let i = 0; i < wanted.length; i += 1) {
            PICTURE_SIGNATURE_CACHE.set(wanted[i], signatures[i]);
        }
    });
}

/** Whether any picture in the payload is only recognisable by its bytes. */
function payloadNeedsSignatures(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    for (let n = 0; n < PAYLOAD_LIST_NAMES.length; n += 1) {
        const records = payload[PAYLOAD_LIST_NAMES[n]];
        if (!Array.isArray(records)) {
            continue;
        }
        for (let i = 0; i < records.length; i += 1) {
            const record = records[i];
            if (!record || typeof record !== 'object') {
                continue;
            }
            if (Array.isArray(record.images)) {
                for (let j = 0; j < record.images.length; j += 1) {
                    if (typeof record.images[j] === 'string' && record.images[j]) {
                        return true;
                    }
                }
            }
            if (Array.isArray(record.media)) {
                for (let k = 0; k < record.media.length; k += 1) {
                    const entry = record.media[k];
                    const url = mediaEntryUrl(entry);
                    if (url && url.indexOf('data:') === 0) {
                        return true;
                    }
                    if (entry && typeof entry === 'object' && (typeof entry.data === 'string' || typeof entry.base64 === 'string')) {
                        return true;
                    }
                }
            }
            if (!Array.isArray(record.content)) {
                continue;
            }
            for (let m = 0; m < record.content.length; m += 1) {
                const ref = pictureBlockRef(record.content[m]);
                if (ref && ref.base64) {
                    return true;
                }
            }
        }
    }
    return false;
}

/** The index a gallery record points at. */
function mediaIndexNumber(record) {
    const index = Number(record && record.mediaIndex !== undefined ? record.mediaIndex : 0);
    return Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
}

/**
 * Walk one request record: its media list, its inline bytes and its text.
 * @param {object} record
 * @param {Set<string>} keys
 * @param {boolean} allowBytes
 * @param {boolean} apply
 * @param {{seen:number,removed:number}} totals
 */
function scanRecord(record, keys, allowBytes, apply, totals) {
    if (Array.isArray(record.media)) {
        if (record.mediaDisplay === 'gallery') {
            const index = mediaIndexNumber(record);
            const current = record.media[index];
            if (current) {
                totals.seen += 1;
                if (mediaEntryIsWithheld(current, keys, allowBytes)) {
                    totals.removed += 1;
                    if (apply) {
                        // The record already points at the list, so it is emptied,
                        // never spliced in place: the chat's own array stays intact.
                        record.media = [];
                    }
                }
            }
        } else {
            const kept = [];
            let dropped = 0;
            for (let i = 0; i < record.media.length; i += 1) {
                const entry = record.media[i];
                totals.seen += 1;
                if (mediaEntryIsWithheld(entry, keys, allowBytes)) {
                    dropped += 1;
                    continue;
                }
                kept.push(entry);
            }
            if (dropped > 0) {
                totals.removed += dropped;
                if (apply) {
                    record.media = kept;
                }
            }
        }
    }

    if (Array.isArray(record.images)) {
        const keptImages = [];
        let droppedImages = 0;
        for (let i = 0; i < record.images.length; i += 1) {
            const data = record.images[i];
            totals.seen += 1;
            if (allowBytes && typeof data === 'string' && base64LooksWithheld(data, keys)) {
                droppedImages += 1;
                continue;
            }
            keptImages.push(data);
        }
        if (droppedImages > 0) {
            totals.removed += droppedImages;
            if (apply) {
                record.images = keptImages;
            }
        }
    }

    const content = record.content;
    if (typeof content === 'string') {
        const before = countPictureMarkup(content);
        totals.seen += before;
        if (apply && before > 0) {
            const replaced = stripWithheldMarkup(content, keys);
            if (replaced !== null) {
                totals.removed += Math.max(0, before - countPictureMarkup(replaced));
                record.content = replaced;
            }
        }
        return;
    }
    if (!Array.isArray(content)) {
        return;
    }

    const keptBlocks = [];
    let droppedBlocks = 0;
    for (let i = 0; i < content.length; i += 1) {
        const block = content[i];
        const ref = pictureBlockRef(block);
        if (ref) {
            totals.seen += 1;
            if (blockIsWithheld(ref, keys, allowBytes)) {
                droppedBlocks += 1;
                continue;
            }
            keptBlocks.push(block);
            continue;
        }
        if (block && typeof block.text === 'string') {
            const before = countPictureMarkup(block.text);
            totals.seen += before;
            if (apply && before > 0) {
                const replaced = stripWithheldMarkup(block.text, keys);
                if (replaced !== null) {
                    totals.removed += Math.max(0, before - countPictureMarkup(replaced));
                    block.text = replaced;
                }
            }
        }
        keptBlocks.push(block);
    }
    if (droppedBlocks > 0) {
        totals.removed += droppedBlocks;
        if (apply) {
            record.content = keptBlocks;
        }
    }
}

/**
 * Walk a whole request payload and drop the switched-off pictures from it.
 *
 * The same pass counts what it saw, which is what the summary reports: the images
 * that actually went out, not a guess from the screen.
 * @param {object} payload
 * @param {Set<string>} keys
 * @param {boolean} allowBytes
 * @param {boolean} apply
 * @returns {{seen:number, removed:number, records:number}}
 */
function scanPayload(payload, keys, allowBytes, apply) {
    const totals = { seen: 0, removed: 0, records: 0 };
    if (!payload || typeof payload !== 'object') {
        return totals;
    }
    for (let n = 0; n < PAYLOAD_LIST_NAMES.length; n += 1) {
        const name = PAYLOAD_LIST_NAMES[n];
        const value = payload[name];
        if (typeof value === 'string') {
            const before = countPictureMarkup(value);
            totals.seen += before;
            if (apply && before > 0) {
                const replaced = stripWithheldMarkup(value, keys);
                if (replaced !== null) {
                    totals.removed += Math.max(0, before - countPictureMarkup(replaced));
                    payload[name] = replaced;
                }
            }
            continue;
        }
        if (!Array.isArray(value)) {
            continue;
        }
        for (let i = 0; i < value.length; i += 1) {
            const record = value[i];
            if (!record || typeof record !== 'object') {
                continue;
            }
            totals.records += 1;
            scanRecord(record, keys, allowBytes, apply, totals);
        }
    }
    return totals;
}

/* ------------------------------------------------------------------ */
/* the summary line                                                    */
/* ------------------------------------------------------------------ */

/** A new turn may show its summary even when the numbers repeat. */
function resetOutgoingReport() {
    outgoingLine = null;
}

/**
 * Say how many pictures this turn actually sent.
 *
 * The first number comes from the request itself (counted while stripping), so it
 * cannot drift from reality; the eyes only stand in when the payload showed
 * nothing at all, which happens on a dry run or an unknown request shape.
 */
function announceOutgoing(sent, chatTotal, seen) {
    let reported = sent;
    if (seen <= 0) {
        reported = countOpenPictures(collectCollapseTargets());
    }
    if (reported === 0 && chatTotal === 0) {
        return;
    }
    if (outgoingLine && outgoingLine.sent === reported && outgoingLine.chat === chatTotal) {
        return;
    }
    outgoingLine = { sent: reported, chat: chatTotal };
    if (seen > 0 && seen !== chatTotal) {
        log('the request carried ' + seen + ' picture(s); ' + chatTotal + ' are drawn in the chat');
    }
    miniNotice(fillPlaceholders(
        translateText('Sent ${0} image(s) this turn, the chat holds ${1} in all.'),
        reported,
        chatTotal,
    ));
}

/**
 * Hooked to every request the host builds. Returns a promise when inline bytes
 * have to be resolved first, so the host waits for the final payload.
 * @param {object} payload
 * @param {boolean} speak whether to show the summary line
 */
function excludeFoldedMediaFromPrompt(payload, speak) {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const keys = withheldKeys();
    const chatTotal = countMediaItems(collectCollapseTargets());
    const first = scanPayload(payload, keys, false, true);
    if (first.removed > 0) {
        log('left ' + first.removed + ' switched-off picture(s) out of the prompt');
    }

    const finish = (extraRemoved) => {
        if (!speak) {
            return;
        }
        const sent = Math.max(0, first.seen - first.removed - extraRemoved);
        announceOutgoing(sent, chatTotal, first.seen);
    };

    if (keys.size === 0 || !payloadNeedsSignatures(payload)) {
        finish(0);
        return undefined;
    }
    // Some copies of a picture are inlined as bytes, so the path cannot match them.
    return ensureSignatures(keys).then(() => {
        const second = scanPayload(payload, keys, true, true);
        if (second.removed > 0) {
            log('left ' + second.removed + ' more switched-off picture(s) out of the prompt by content');
        }
        finish(second.removed);
    }).catch((error) => {
        console.error(DEBUG_PREFIX, 'could not filter switched-off media out of the prompt', error);
        finish(0);
    });
}

/** One event handler, with every failure contained so the host never sees it. */
function runPromptFilter(payload, speak) {
    try {
        const pending = excludeFoldedMediaFromPrompt(payload, speak);
        if (pending && typeof pending.then === 'function') {
            return pending.catch((error) => {
                console.error(DEBUG_PREFIX, 'prompt filter failed', error);
            });
        }
        return pending;
    } catch (error) {
        console.error(DEBUG_PREFIX, 'prompt filter failed', error);
        return undefined;
    }
}

/** Subscribe to the three request events the host offers. */
function installPromptFilter() {
    if (promptFilterInstalled) {
        return;
    }
    const ctx = safeContext();
    if (!ctx || !ctx.eventSource || typeof ctx.eventSource.on !== 'function') {
        log('no event source yet; switched-off media cannot be kept out of the prompt');
        return;
    }
    const types = ctx.eventTypes || {};
    const hooked = [];
    const attach = (name, speak) => {
        const type = types[name];
        if (!type) {
            return;
        }
        ctx.eventSource.on(type, (payload) => runPromptFilter(payload, speak));
        hooked.push(name);
    };
    attach('CHAT_COMPLETION_PROMPT_READY', false);
    attach('GENERATE_AFTER_DATA', true);
    attach('GENERATE_AFTER_COMBINE_PROMPTS', true);
    if (types.MESSAGE_SENT) {
        ctx.eventSource.on(types.MESSAGE_SENT, () => resetOutgoingReport());
    }
    if (types.GENERATION_STARTED) {
        ctx.eventSource.on(types.GENERATION_STARTED, () => resetOutgoingReport());
    }
    promptFilterInstalled = hooked.length > 0;
    log('switched-off media will be kept out of the prompt (' + hooked.length + ' hook(s))');
}

/* ------------------------------------------------------------------ */
/* extension entry point                                              */
/* ------------------------------------------------------------------ */

let initialized = false;

/**
 * Renders this extension's block in the host's Extensions settings drawer.
 * Optional: silently skipped when the container is missing.
 */
function renderSettingsPanel() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('tt_editpaste_settings')) {
        return;
    }

    const settings = getSettings();
    const block = document.createElement('div');
    block.id = 'tt_editpaste_settings';
    block.className = 'tt-editpaste-settings';
    block.innerHTML =
        '<div class="inline-drawer">' +
        '  <div class="inline-drawer-toggle inline-drawer-header">' +
        '    <b>ST-ImagePlus</b>' +
        '    <small class="tt-editpaste-version">v' + EXTENSION_VERSION + '</small>' +
        '    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
        '  </div>' +
        '  <div class="inline-drawer-content">' +
        '    <small data-i18n="Paster: paste or drop an image into the message editor. Compresser: automatically shrink oversized images before upload. Downloader: save an image, or jump to the message it came from. Folding: put a collapse bar above every image and media item.">' +
        '    贴图（Paster）：在编辑框粘贴／拖入图片。压缩（Compresser）：上传前自动缩小超标的图片。' +
        '    下载（Downloader）：把图片存下来，或跳到它所在的楼层。' +
        '    折叠（Folding）：在每张图片／媒体上方放一条折叠条。</small>' +
        '    <label class="checkbox_label" for="tt_editpaste_enabled">' +
        '      <input id="tt_editpaste_enabled" type="checkbox">' +
        '      <span data-i18n="Enable paste and drop in the message editor">启用编辑框粘贴／拖放</span>' +
        '    </label>' +
        '    <label for="tt_editpaste_maxsize" data-i18n="Maximum size per image (MB)">单张图片大小上限（MB）</label>' +
        '    <input id="tt_editpaste_maxsize" class="text_pole" type="number" min="1" max="100" step="1">' +
        '    <hr>' +
        '    <label class="checkbox_label" for="tt_editpaste_compress">' +
        '      <input id="tt_editpaste_compress" type="checkbox">' +
        '      <span data-i18n="Compress images automatically">自动压缩图片</span>' +
        '    </label>' +
        '    <label for="tt_editpaste_target_kb" data-i18n="Target size after compression (KB)">压缩后文件大小上限（KB）</label>' +
        '    <input id="tt_editpaste_target_kb" class="text_pole" type="number" min="10" max="20000" step="10">' +
        '    <label class="checkbox_label" for="tt_editpaste_limit_edge">' +
        '      <input id="tt_editpaste_limit_edge" type="checkbox">' +
        '      <span data-i18n="Also limit the long edge">同时限制长边尺寸</span>' +
        '    </label>' +
        '    <label for="tt_editpaste_max_edge" data-i18n="Maximum long edge after compression (px)">压缩后长边最大尺寸（px）</label>' +
        '    <input id="tt_editpaste_max_edge" class="text_pole" type="number" min="100" max="20000" step="100">' +
        '    <label for="tt_editpaste_min_quality" data-i18n="Minimum quality (lower bound)">最低可接受画质</label>' +
        '    <input id="tt_editpaste_min_quality" class="text_pole" type="number" min="0.1" max="1" step="0.05">' +
        '    <small data-i18n="Images that are already within the size limit are left untouched. Compression re-encodes to WebP, falls back to JPEG when WebP is unsupported, and removes metadata such as EXIF. Quality is lowered first; the image is only scaled down when the lowest acceptable quality is still too large.">' +
        '    图片不超过大小上限时不做任何处理。压缩会重新编码为 WebP（不支持时退回 JPEG），并清除 EXIF 等元数据。' +
        '    优先降低画质，只有画质降到底仍然超标时才会缩小尺寸。</small>' +
        '    <small data-i18n="Paste an image into the message editor with Ctrl+V, or drag an image into the editor. The unsent input box behaves the same way.">' +
        '    在编辑框（铅笔图标）内按 Ctrl+V 粘贴，或把图片拖进编辑框；未送出的输入框同样有效。' +
        '    图片会存到 <code>user/images/&lt;角色名&gt;/</code>，与内置附件相同。</small>' +
        '    <hr>' +
        '    <label class="checkbox_label" for="tt_editpaste_viewer_download">' +
        '      <input id="tt_editpaste_viewer_download" type="checkbox">' +
        '      <span data-i18n="Show a download button in the image viewer">在图片检视器右下角显示下载按钮</span>' +
        '    </label>' +
        '    <label class="checkbox_label" for="tt_editpaste_long_press">' +
        '      <input id="tt_editpaste_long_press" type="checkbox">' +
        '      <span data-i18n="Hold an image on a touch screen to download it">触控装置上长按图片下载</span>' +
        '    </label>' +
        '    <small data-i18n="Both are off by default because recent TauriTavern saves an image on its own (long press on the image, or its own button). Turn them on for older builds that cannot.">' +
        '    上面两项默认关闭：新版 TauriTavern 自己就能存图（长按图片，或它自己的按钮）。' +
        '    只有旧版无法存图时才需要打开。</small>' +
        '    <small data-i18n="Holding an image asks for confirmation first, so it cannot fire by accident. Only applies on touch screens.">' +
        '    长按图片会先弹出确认再下载，避免误触。只对触控屏幕有效。</small>' +
        '    <hr>' +
        '    <label class="checkbox_label" for="tt_editpaste_collapse_media">' +
        '      <input id="tt_editpaste_collapse_media" type="checkbox">' +
        '      <span data-i18n="Show a collapse bar above every image and media item in the chat">在对话里的每张图片／媒体上方显示折叠条</span>' +
        '    </label>' +
        '    <small data-i18n="Each image and media item gets its own bar at its top; click a bar to fold or unfold just that one. The wand menu entry does the same for the whole chat.">' +
        '    每张图片／媒体都会在<strong>最顶端</strong>有自己的折叠条，按一下就只折／开那一张。' +
        '    魔杖选单里的项目则是一次切换整个聊天。</small>' +
        '    <small data-i18n="Every collapse bar carries an eye on its right: a bright eye means that picture goes out with the message, a dimmed one means it stays behind. It only changes what is sent: the chat file is never touched.">' +
        '    换成右边那颗眼睛来管：<strong>眼睛亮着</strong>＝这张图跟着消息送出去，<strong>眼睛暗掉</strong>＝这张图不送。' +
        '    只影响「送出去的内容」，<strong>不会改动聊天存档</strong>。</small>' +
        '    <hr>' +
        '    <label class="checkbox_label" for="tt_editpaste_mute">' +
        '      <input id="tt_editpaste_mute" type="checkbox">' +
        '      <span data-i18n="Silence every popup and toast from this extension">禁用全部弹窗提示</span>' +
        '    </label>' +
        '    <small data-i18n="The fold count in the wand menu, saving an image and deleting one all report through a popup, and the send summary is a line at the bottom of the window. Silencing here stops all of them; the features themselves keep working.">' +
        '    魔杖的折叠／展开张数、保存图片、删除图片这些提示会一起静音，' +
        '    发送时底部那行摘要也不会再出现。只是不再通知，<strong>功能照常生效</strong>。</small>' +
        '  </div>' +
        '</div>';

    container.appendChild(block);

    const enabledInput = block.querySelector('#tt_editpaste_enabled');
    const maxSizeInput = block.querySelector('#tt_editpaste_maxsize');
    const compressInput = block.querySelector('#tt_editpaste_compress');
    const targetKbInput = block.querySelector('#tt_editpaste_target_kb');
    const limitEdgeInput = block.querySelector('#tt_editpaste_limit_edge');
    const maxEdgeInput = block.querySelector('#tt_editpaste_max_edge');
    const minQualityInput = block.querySelector('#tt_editpaste_min_quality');
    const longPressInput = block.querySelector('#tt_editpaste_long_press');
    const viewerDownloadInput = block.querySelector('#tt_editpaste_viewer_download');
    const collapseMediaInput = block.querySelector('#tt_editpaste_collapse_media');
    const muteInput = block.querySelector('#tt_editpaste_mute');

    enabledInput.checked = settings.enabled;
    maxSizeInput.value = String(Math.round(settings.max_image_bytes / (1024 * 1024)));
    compressInput.checked = settings.compress_enabled;
    targetKbInput.value = String(settings.compress_target_kb);
    limitEdgeInput.checked = settings.compress_limit_dimension;
    maxEdgeInput.value = String(settings.compress_max_edge);
    minQualityInput.value = String(settings.compress_min_quality);
    longPressInput.checked = settings.long_press_download;
    viewerDownloadInput.checked = settings.viewer_download_button;
    collapseMediaInput.checked = settings.collapse_media_bars;
    muteInput.checked = settings.mute_notifications;

    const syncCompressionInputs = () => {
        const off = !settings.compress_enabled;
        targetKbInput.disabled = off;
        limitEdgeInput.disabled = off;
        maxEdgeInput.disabled = off || !settings.compress_limit_dimension;
        minQualityInput.disabled = off;
    };
    syncCompressionInputs();

    const persist = () => {
        const ctx = safeContext();
        if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    };

    enabledInput.addEventListener('change', () => {
        settings.enabled = enabledInput.checked;
        persist();
    });
    maxSizeInput.addEventListener('change', () => {
        settings.max_image_bytes = readClampedNumber(maxSizeInput, 1, 100, 25) * 1024 * 1024;
        maxSizeInput.value = String(Math.round(settings.max_image_bytes / (1024 * 1024)));
        persist();
    });
    compressInput.addEventListener('change', () => {
        settings.compress_enabled = compressInput.checked;
        syncCompressionInputs();
        persist();
    });
    targetKbInput.addEventListener('change', () => {
        settings.compress_target_kb = Math.round(readClampedNumber(targetKbInput, 10, 20000, 500));
        targetKbInput.value = String(settings.compress_target_kb);
        persist();
    });
    limitEdgeInput.addEventListener('change', () => {
        settings.compress_limit_dimension = limitEdgeInput.checked;
        syncCompressionInputs();
        persist();
    });
    maxEdgeInput.addEventListener('change', () => {
        settings.compress_max_edge = Math.round(readClampedNumber(maxEdgeInput, 100, 20000, 2000));
        maxEdgeInput.value = String(settings.compress_max_edge);
        persist();
    });
    minQualityInput.addEventListener('change', () => {
        settings.compress_min_quality = readClampedNumber(minQualityInput, 0.1, 1, 0.5);
        minQualityInput.value = String(settings.compress_min_quality);
        persist();
    });
    longPressInput.addEventListener('change', () => {
        settings.long_press_download = longPressInput.checked;
        persist();
    });
    viewerDownloadInput.addEventListener('change', () => {
        settings.viewer_download_button = viewerDownloadInput.checked;
        // The control is added by the reconciler, so force one pass right away.
        enhanceImageViewers();
        persist();
    });
    collapseMediaInput.addEventListener('change', () => {
        settings.collapse_media_bars = collapseMediaInput.checked;
        enhanceMediaCollapse();
        persist();
    });
    muteInput.addEventListener('change', () => {
        settings.mute_notifications = muteInput.checked;
        persist();
    });
}

/**
 * Extension entry point.
 *
 * TauriTavern / SillyTavern only inject the extension bundle as a module
 * script; they do not call an exported `init()` for arbitrary third-party
 * extensions, so the module self-initializes on DOM-ready. `init()` stays
 * exported (and idempotent) for hosts that do call it.
 * @returns {Promise<boolean>} true when this call performed the setup
 */
export async function init() {
    if (initialized) {
        return false;
    }
    initialized = true;

    const ctx = safeContext();
    getSettings();

    // 0) the eyes live in the chat metadata and are read on demand; only the
    //    in-memory fallback has to start clean.
    resetSendMemory();

    // 1) the interval reconciler + the capture-phase safety net
    startSync();

    // 1b) download surfaces: the lightbox corner control and "hold to download"
    installViewerHooks();
    installLongPressDownload();

    // 1c) keep folded media out of what is sent to the model
    installPromptFilter();

    // 1d) the wand menu may only be rendered after the wand is pressed
    installWandEntryHooks();

    // 2) fresh chat -> no editor is open anymore
    if (ctx && ctx.eventSource && ctx.eventTypes) {
        const refresh = () => {
            OPEN_EDITOR_MESSAGE_ID.clear();
            BUSY_MESSAGES.clear();
            // Another chat starts with its own pictures; the in-memory eyes were
            // made for the chat that is being left behind.
            resetSendMemory();
            window.setTimeout(clearDragHighlights, 0);
        };

        const rerenderMedia = (messageId) => {
            // The host re-renders the message body on save; media images live in
            // a sibling wrapper, so make sure they are (re)drawn.
            window.setTimeout(() => {
                try {
                    renderMessageMedia(safeContext(), Number(messageId));
                } catch (error) {
                    log('media re-render after save failed', error);
                }
            }, 60);
        };

        if (ctx.eventTypes.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, refresh);
        }
        if (ctx.eventTypes.MESSAGE_DELETED) {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, refresh);
        }
        if (ctx.eventTypes.MESSAGE_UPDATED) {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_UPDATED, rerenderMedia);
        }
    }

    // 3) optional settings block in the Extensions drawer
    renderSettingsPanel();

    // 4) expose minimal hooks for power users / debugging in the console.
    globalThis.__pcd = {
        version: EXTENSION_VERSION,
        attachImageToMessage,
        uploadImage,
        getSettings,
        downloadImageUrl,
        downloadImageViaAnchor,
        openImageLocation,
        // `__pcd.mediaCollapseReport()` answers "why are there no bars?" without
        // another round trip: it says what the reconciler can see right now.
        mediaCollapseReport,
        toggleAllMedia,
    };

    // Say the collapse state once at start-up, so a console check is conclusive.
    window.setTimeout(() => {
        log('media collapse at start-up', mediaCollapseReport());
    }, 1500);

    log('initialized v' + EXTENSION_VERSION
        + ' — paste or drop an image into the message editor (pencil button)');
    return true;
}

// Self-start: the extension bundle is injected as a module script, so run
// once the DOM is ready. Guarded by `initialized` against double setup.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init().catch((error) => console.error(DEBUG_PREFIX, 'init failed', error));
        }, { once: true });
    } else {
        init().catch((error) => console.error(DEBUG_PREFIX, 'init failed', error));
    }
}

export default {
    init,
};
