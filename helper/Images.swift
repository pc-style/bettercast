// Image handling: decode any ImageIO format (PNG, TIFF, JPEG, ...), re-encode
// as PNG, make thumbnails, and store clips once under <data>/clips.

import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

struct EncodedImage {
    let png: Data
    let width: Int
    let height: Int
}

enum ImageError: Error { case decode, encode }

func decodeImage(_ data: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil),
          CGImageSourceGetCount(src) > 0 else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary)
}

func encodePNG(_ image: CGImage) throws -> Data {
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else {
        throw ImageError.encode
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw ImageError.encode }
    return out as Data
}

/// Any supported image bytes -> PNG bytes + pixel size. Container bytes
/// can differ for equivalent pixels; they are not the clip identity.
func toPNG(_ data: Data) throws -> EncodedImage {
    guard let img = decodeImage(data) else { throw ImageError.decode }
    return EncodedImage(png: try encodePNG(img), width: img.width, height: img.height)
}

/// Downscaled copy (longest side <= maxSide) as PNG; the original when it is
/// already small enough.
func thumbnailPNG(_ data: Data, maxSide: Int) throws -> EncodedImage {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw ImageError.decode }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxSide,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { throw ImageError.decode }
    return EncodedImage(png: try encodePNG(img), width: img.width, height: img.height)
}

/// Uncompressed 32-bit RGBA TIFF of `image` (what some apps, and Raycast's
/// history, keep: 4 bytes per pixel). Used as the pasteboard fallback rep
/// and by the selftest.
func encodeTIFF(_ image: CGImage) throws -> Data {
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, UTType.tiff.identifier as CFString, 1, nil) else {
        throw ImageError.encode
    }
    CGImageDestinationAddImage(dest, image, [kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 1]] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw ImageError.encode }
    return out as Data
}

/// Deterministic synthetic RGBA image (asymmetric size, gradient + noise-ish
/// pattern so PNG has something to compress but not trivially).
func syntheticImage(width: Int, height: Int) -> CGImage {
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    for y in 0..<height {
        for x in 0..<width {
            let i = (y * width + x) * 4
            pixels[i] = UInt8((x * 255) / max(width - 1, 1))
            pixels[i + 1] = UInt8((y * 255) / max(height - 1, 1))
            pixels[i + 2] = UInt8(((x / 8 + y / 8) % 2) * 200)
            pixels[i + 3] = 255
        }
    }
    let provider = CGDataProvider(data: Data(pixels) as CFData)!
    return CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
    )!
}

/// RGBA8 pixels of an image rendered into sRGB (for round-trip comparison).
func rgbaPixels(_ image: CGImage) -> [UInt8] {
    let w = image.width, h = image.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    buf.withUnsafeMutableBytes { raw in
        let ctx = CGContext(
            data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        )!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return buf
}

/// Identity is dimensions plus sRGB RGBA8 premultiplied pixels in explicit
/// byte order. Source encoding, metadata, row padding and alpha layout do
/// not affect it. Include dimensions so equal buffers with different shapes
/// cannot collide. Fully transparent RGB is normalized by rendering.
func imagePixelHash(_ image: CGImage) -> String {
    var content = Data("bettercast-rgba8-srgb-v1:\(image.width)x\(image.height)\0".utf8)
    content.append(contentsOf: rgbaPixels(image))
    return sha256Hex(content)
}

// MARK: - Clip store

struct StoredClip {
    let sha: String
    let bytes: Int
    let width: Int
    let height: Int
    let created: Bool
}

/// Write `data` to `<dir>/clips/<sha>.<ext>` unless it already exists
/// (dedupe: an existing file is never rewritten).
@discardableResult
func storeOnce(_ data: Data, sha: String, ext: String, clipsDir: URL) throws -> Bool {
    let url = clipsDir.appendingPathComponent("\(sha).\(ext)")
    if FileManager.default.fileExists(atPath: url.path) { return false }
    try FileManager.default.createDirectory(at: clipsDir, withIntermediateDirectories: true)
    try writeAtomically(data, to: url)
    return true
}

/// Write to a sibling temp file, then rename: readers never see a partial
/// clip, and no system replacement directory is needed.
func writeAtomically(_ data: Data, to url: URL) throws {
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
    try data.write(to: tmp)
    if rename(tmp.path, url.path) != 0 {
        let err = errno
        try? FileManager.default.removeItem(at: tmp)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(err))
    }
}

func storeTextClip(_ text: String, clipsDir: URL) throws -> StoredClip {
    let data = Data(text.utf8)
    let sha = sha256Hex(data)
    let created = try storeOnce(data, sha: sha, ext: "txt", clipsDir: clipsDir)
    return StoredClip(sha: sha, bytes: data.count, width: 0, height: 0, created: created)
}

let thumbnailMaxSide = 256

/// Re-encode as PNG, store `<pixel-sha>.png` once plus `<pixel-sha>.thumb.png`
/// (longest side <= 256 px).
func storeImageClip(_ source: Data, clipsDir: URL) throws -> StoredClip {
    guard let image = decodeImage(source) else { throw ImageError.decode }
    let sha = imagePixelHash(image)
    let originalURL = clipsDir.appendingPathComponent("\(sha).png")
    // Preserve the first encoding. All later representations report its
    // actual byte count and use it when recreating a missing thumbnail.
    let png = FileManager.default.fileExists(atPath: originalURL.path)
        ? try Data(contentsOf: originalURL) : try encodePNG(image)
    let enc = EncodedImage(png: png, width: image.width, height: image.height)
    let created = try storeOnce(enc.png, sha: sha, ext: "png", clipsDir: clipsDir)
    let thumbURL = clipsDir.appendingPathComponent("\(sha).thumb.png")
    if !FileManager.default.fileExists(atPath: thumbURL.path) {
        let thumb = max(enc.width, enc.height) <= thumbnailMaxSide ? enc : try thumbnailPNG(enc.png, maxSide: thumbnailMaxSide)
        try writeAtomically(thumb.png, to: thumbURL)
    }
    return StoredClip(sha: sha, bytes: enc.png.count, width: enc.width, height: enc.height, created: created)
}
