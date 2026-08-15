import { inflateRawSync } from "node:zlib";

/**
 * Minimal zip reader for managed skill bundles (RFC 0002 skill.md). Bundles
 * are small, well-formed zips produced by the OpenRouter managed skills API
 * (`SKILL.md` at the root plus support files), so this walks the central
 * directory and supports the two compression methods zip writers emit in
 * practice: stored and deflate. Owning ~100 lines beats pulling in an archive
 * dependency for this one boundary.
 */

interface SkillBundleFile {
  readonly data: Uint8Array;
  readonly path: string;
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02_01_4b_50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04_03_4b_50;
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;
const MAX_ZIP_COMMENT_LENGTH = 0xff_ff;
const CENTRAL_METHOD_OFFSET = 10;
const CENTRAL_COMPRESSED_SIZE_OFFSET = 20;
const CENTRAL_NAME_LENGTH_OFFSET = 28;
const CENTRAL_EXTRA_LENGTH_OFFSET = 30;
const CENTRAL_COMMENT_LENGTH_OFFSET = 32;
const CENTRAL_LOCAL_OFFSET_OFFSET = 42;
const LOCAL_NAME_LENGTH_OFFSET = 26;
const LOCAL_EXTRA_LENGTH_OFFSET = 28;
const END_ENTRY_COUNT_OFFSET = 10;
const END_CENTRAL_START_OFFSET = 16;

const findEndOfCentralDirectory = (view: DataView): number => {
  const earliest = Math.max(
    0,
    view.byteLength - END_OF_CENTRAL_DIRECTORY_MIN_SIZE - MAX_ZIP_COMMENT_LENGTH
  );
  for (
    let offset = view.byteLength - END_OF_CENTRAL_DIRECTORY_MIN_SIZE;
    offset >= earliest;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("skill bundle is not a zip archive (no central directory)");
};

const isSafeBundlePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((part) => part === ".." || part === "");

const decompressEntry = (
  compressed: Uint8Array,
  method: number,
  path: string
): Uint8Array => {
  if (method === COMPRESSION_STORED) {
    return compressed;
  }
  if (method === COMPRESSION_DEFLATE) {
    return new Uint8Array(inflateRawSync(compressed));
  }
  throw new Error(
    `skill bundle entry "${path}" uses unsupported compression method ${method}`
  );
};

const readCompressedEntryData = (
  bytes: Uint8Array,
  view: DataView,
  entry: {
    readonly compressedSize: number;
    readonly localOffset: number;
    readonly path: string;
  }
): Uint8Array => {
  if (view.getUint32(entry.localOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(
      `skill bundle entry "${entry.path}" has a corrupt local header`
    );
  }
  const localNameLength = view.getUint16(
    entry.localOffset + LOCAL_NAME_LENGTH_OFFSET,
    true
  );
  const localExtraLength = view.getUint16(
    entry.localOffset + LOCAL_EXTRA_LENGTH_OFFSET,
    true
  );
  const dataStart =
    entry.localOffset +
    LOCAL_FILE_HEADER_SIZE +
    localNameLength +
    localExtraLength;
  return bytes.subarray(dataStart, dataStart + entry.compressedSize);
};

const readEntry = (
  bytes: Uint8Array,
  view: DataView,
  centralOffset: number
): { readonly file: SkillBundleFile | undefined; readonly next: number } => {
  if (view.getUint32(centralOffset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error("skill bundle central directory is corrupt");
  }
  const nameLength = view.getUint16(
    centralOffset + CENTRAL_NAME_LENGTH_OFFSET,
    true
  );
  const extraLength = view.getUint16(
    centralOffset + CENTRAL_EXTRA_LENGTH_OFFSET,
    true
  );
  const commentLength = view.getUint16(
    centralOffset + CENTRAL_COMMENT_LENGTH_OFFSET,
    true
  );
  const next =
    centralOffset +
    CENTRAL_DIRECTORY_HEADER_SIZE +
    nameLength +
    extraLength +
    commentLength;

  const method = view.getUint16(centralOffset + CENTRAL_METHOD_OFFSET, true);
  const compressedSize = view.getUint32(
    centralOffset + CENTRAL_COMPRESSED_SIZE_OFFSET,
    true
  );
  const localOffset = view.getUint32(
    centralOffset + CENTRAL_LOCAL_OFFSET_OFFSET,
    true
  );
  const path = new TextDecoder().decode(
    bytes.subarray(
      centralOffset + CENTRAL_DIRECTORY_HEADER_SIZE,
      centralOffset + CENTRAL_DIRECTORY_HEADER_SIZE + nameLength
    )
  );

  if (path.endsWith("/")) {
    return {
      file: undefined,
      next,
    };
  }
  if (!isSafeBundlePath(path)) {
    throw new Error(`skill bundle entry has an unsafe path: "${path}"`);
  }
  const compressed = readCompressedEntryData(bytes, view, {
    compressedSize,
    localOffset,
    path,
  });

  return {
    file: {
      data: decompressEntry(compressed, method, path),
      path,
    },
    next,
  };
};

export const extractSkillBundleZip = (
  bytes: Uint8Array
): readonly SkillBundleFile[] => {
  if (bytes.byteLength < END_OF_CENTRAL_DIRECTORY_MIN_SIZE) {
    throw new Error("skill bundle is too small to be a zip archive");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(endOffset + END_ENTRY_COUNT_OFFSET, true);
  const centralStart = view.getUint32(
    endOffset + END_CENTRAL_START_OFFSET,
    true
  );

  const files: SkillBundleFile[] = [];
  let offset = centralStart;
  for (let index = 0; index < entryCount; index += 1) {
    const { file, next } = readEntry(bytes, view, offset);
    if (file !== undefined) {
      files.push(file);
    }
    offset = next;
  }
  return files;
};

export type { SkillBundleFile };
