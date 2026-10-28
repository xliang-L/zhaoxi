import Foundation
import Vision
import PDFKit
import AppKit

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
var parts: [String] = []
var partial = false
var pages = 1
var hasContent = false
do {
    if url.pathExtension.lowercased() == "pdf", let document = PDFDocument(url: url) {
        pages = document.pageCount
        partial = pages > 20
        for index in 0..<min(pages, 20) {
            guard let page = document.page(at: index) else { continue }
            var text = page.string ?? ""
            if text.trimmingCharacters(in: .whitespacesAndNewlines).count < 10 {
                let image = page.thumbnail(of: NSSize(width: 1600, height: 2200), for: .mediaBox)
                if let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) { let recognized = try recognize(cg); if !recognized.isEmpty { text = recognized } }
            }
            hasContent = hasContent || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            parts.append("[第\(index + 1)页]\n" + text)
            if parts.joined().count > 32000 { partial = true; break }
        }
    } else if let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        let text = try recognize(cg); parts.append(text); hasContent = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let text = parts.joined(separator: "\n")
    partial = partial || text.count > 32000
    let status = !hasContent ? "unreadable" : partial ? "partial" : "ready"
    let output: [String: Any] = ["status": status, "text": String(text.prefix(32000)), "pages": pages,
                               "warning": partial ? "仅读取前20页或32000字，其余内容尚未读取。" : "图片或扫描件由本机识别，日期、数字和模糊文字需要核对。"]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} catch {
    print("{\"status\":\"unreadable\",\"text\":\"\",\"warning\":\"未能读取图片或PDF，请重新提供清晰原件。\"}")
}
