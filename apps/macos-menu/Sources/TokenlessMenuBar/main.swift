import AppKit
import Combine
import Foundation
import ServiceManagement
import SwiftUI

private enum SnapshotLanguage: String {
    case english = "en"
    case simplifiedChinese = "zh-CN"

    var locale: Locale {
        switch self {
        case .english:
            return Locale(identifier: "en_US")
        case .simplifiedChinese:
            return Locale(identifier: "zh_CN")
        }
    }
}

private struct LocalizedText {
    let english: String
    let chinese: String

    func value(for language: SnapshotLanguage) -> String {
        language == .simplifiedChinese ? chinese : english
    }
}

private struct EmbeddedRuntime {
    let nodeExecutable: URL
    let cliEntrypoint: URL
    let homeDirectory: URL
}

private struct CLIErrorPayload: Decodable {
    let code: String?
    let message: String?
}

private struct CLIResponse: Decodable {
    let ok: Bool?
    let error: CLIErrorPayload?
}

private struct DaemonInfo: Decodable {
    let status: String?
    let version: String?
}

private struct MenuBarConversation: Decodable, Identifiable {
    let jobId: String
    let title: String
    let provider: String
    let providers: [String]?
    let status: String
    let updatedAt: String
    let profileId: String?
    let profileSlug: String?

    var id: String { jobId }
}

private struct MenuBarSnapshot: Decodable {
    let ok: Bool?
    let error: CLIErrorPayload?
    let language: String?
    let daemon: DaemonInfo?
    let activeJobCount: Int?
    let dashboardUrl: String?
    let conversations: [MenuBarConversation]?
}

private struct ConfigPayload: Decodable {
    let language: String?
}

private struct ConfigResponse: Decodable {
    let ok: Bool?
    let error: CLIErrorPayload?
    let config: ConfigPayload?
}

private struct UpgradeResponse: Decodable {
    let ok: Bool?
    let error: CLIErrorPayload?
    let current: String?
    let latest: String?
    let status: String?
    let updateAvailable: Bool?
}

private struct CLIInvocationResult {
    let data: Data
    let exitCode: Int32
}

private enum PendingConfirmation {
    case restart
    case quit
}

private enum UpdateState {
    case idle
    case checking
    case upToDate(version: String?)
    case available(version: String?)
    case unavailable
    case upgrading
    case upgraded

    var isBusy: Bool {
        switch self {
        case .checking, .upgrading:
            return true
        default:
            return false
        }
    }
}

private enum TokenlessAppError: LocalizedError {
    case runtimeUnavailable
    case runtimeInvalid
    case processLaunchFailed
    case processFailed
    case invalidJSON
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .runtimeUnavailable:
            return "Tokenless embedded runtime is unavailable. Rebuild and reinstall the macOS app."
        case .runtimeInvalid:
            return "Tokenless embedded runtime is invalid. Rebuild and reinstall the macOS app."
        case .processLaunchFailed:
            return "Tokenless could not start its local CLI."
        case .processFailed:
            return "The Tokenless CLI exited without a usable result."
        case .invalidJSON:
            return "Tokenless returned an invalid local response."
        case let .commandFailed(message):
            return message
        }
    }
}

@MainActor
private final class AppModel: ObservableObject {
    @Published private(set) var snapshot: MenuBarSnapshot?
    @Published private(set) var language: SnapshotLanguage = .english
    @Published private(set) var isRefreshing = false
    @Published private(set) var updateState: UpdateState = .idle
    @Published private(set) var updateMessage: String?
    @Published private(set) var operationMessage: String?
    @Published private(set) var errorMessage: String?
    @Published var pendingConfirmation: PendingConfirmation?
    @Published var launchAtLogin = false

    private var refreshTask: Task<Void, Never>?
    private var runtime: EmbeddedRuntime?

    init() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
        refreshOnAppear()
    }

    deinit {
        refreshTask?.cancel()
    }

    var conversations: [MenuBarConversation] {
        Array((snapshot?.conversations ?? []).prefix(10))
    }

    var activeJobCount: Int {
        snapshot?.activeJobCount ?? 0
    }

    var version: String? {
        snapshot?.daemon?.version
    }

    var daemonIsRunning: Bool {
        snapshot?.daemon?.status == "running"
    }

    func text(_ value: LocalizedText) -> String {
        value.value(for: language)
    }

    func refreshOnAppear() {
        guard !isRefreshing else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        errorMessage = nil

        do {
            let response = try await invokeJSON(["menubar", "status", "--json"])
            let payload = try decode(MenuBarSnapshot.self, from: response)
            try requireOK(payload.ok, error: payload.error)
            snapshot = payload
            if let payloadLanguage = payload.language {
                apply(language: payloadLanguage)
            } else {
                await refreshLanguageFromConfig()
            }
        } catch {
            errorMessage = localizedError(error)
        }
    }

    func openDashboard(jobId: String? = nil, profileSlug: String? = nil) {
        operationMessage = nil
        errorMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                var arguments = ["dashboard"]
                if let jobId {
                    arguments.append(contentsOf: ["--job-id", jobId])
                }
                if let profileSlug, !profileSlug.isEmpty {
                    arguments.append(contentsOf: ["--profile", profileSlug])
                }
                arguments.append(contentsOf: ["--json"])
                let response = try await invokeJSON(arguments)
                let payload = try decode(CLIResponse.self, from: response)
                try requireOK(payload.ok, error: payload.error)
                operationMessage = text(LocalizedText(
                    english: "Dashboard opened",
                    chinese: "Dashboard 已打开"
                ))
            } catch {
                errorMessage = localizedError(error)
            }
        }
    }

    func requestRestart() {
        if activeJobCount > 0 {
            pendingConfirmation = .restart
        } else {
            restart()
        }
    }

    func requestQuit() {
        if activeJobCount > 0 {
            pendingConfirmation = .quit
        } else {
            quit()
        }
    }

    func confirmPendingAction() {
        let action = pendingConfirmation
        pendingConfirmation = nil
        switch action {
        case .restart:
            restart()
        case .quit:
            quit()
        case nil:
            break
        }
    }

    func checkForUpdates() {
        guard !updateState.isBusy else { return }
        updateState = .checking
        updateMessage = nil
        errorMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await invokeJSON(["upgrade", "--check", "--json"])
                let payload = try decode(UpgradeResponse.self, from: response)
                if payload.ok != true {
                    updateState = .unavailable
                    errorMessage = commandError(payload.error, fallback: LocalizedText(
                        english: "Could not check for updates.",
                        chinese: "无法检查更新。"
                    ))
                    return
                }
                if payload.updateAvailable == true {
                    updateState = .available(version: payload.latest)
                    updateMessage = versionMessage(
                        english: "Version \(payload.latest ?? "latest") is available.",
                        chinese: "有新版本 \(payload.latest ?? "latest") 可用。"
                    )
                } else {
                    updateState = .upToDate(version: payload.current)
                    updateMessage = versionMessage(
                        english: "You are up to date.",
                        chinese: "当前已是最新版本。"
                    )
                }
            } catch {
                updateState = .unavailable
                errorMessage = localizedError(error)
            }
        }
    }

    func upgrade() {
        guard !updateState.isBusy else { return }
        updateState = .unavailable
        updateMessage = nil
        errorMessage = versionMessage(
            english: "Install the latest Tokenless app to upgrade.",
            chinese: "请安装最新的 Tokenless app 以完成升级。"
        )
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLogin = enabled
            errorMessage = nil
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            errorMessage = commandError(nil, fallback: LocalizedText(
                english: "Could not change Launch at Login.",
                chinese: "无法更改登录时启动设置。"
            ))
        }
    }

    private func restart() {
        operationMessage = text(LocalizedText(
            english: "Restarting Tokenless…",
            chinese: "正在重启 Tokenless…"
        ))
        errorMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                let stopResponse = try await invokeJSON(["daemon", "stop", "--json"])
                let stopPayload = try decode(CLIResponse.self, from: stopResponse)
                try requireOK(stopPayload.ok, error: stopPayload.error)
                await refresh()
                operationMessage = text(LocalizedText(
                    english: "Tokenless restarted",
                    chinese: "Tokenless 已重启"
                ))
            } catch {
                operationMessage = nil
                errorMessage = localizedError(error)
            }
        }
    }

    private func quit() {
        operationMessage = text(LocalizedText(
            english: "Stopping Tokenless…",
            chinese: "正在停止 Tokenless…"
        ))
        errorMessage = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await invokeJSON(["daemon", "stop", "--json"])
                let payload = try decode(CLIResponse.self, from: response)
                try requireOK(payload.ok, error: payload.error)
                NSApplication.shared.terminate(nil)
            } catch {
                operationMessage = nil
                errorMessage = localizedError(error)
            }
        }
    }

    private func refreshLanguageFromConfig() async {
        do {
            let response = try await invokeJSON(["config", "--json"])
            let payload = try decode(ConfigResponse.self, from: response)
            if payload.ok == true, let configuredLanguage = payload.config?.language {
                apply(language: configuredLanguage)
            }
        } catch {
            // The menu snapshot is still useful when the optional language read is unavailable.
        }
    }

    private func apply(language value: String) {
        language = SnapshotLanguage(rawValue: value) ?? .english
    }

    private func invokeJSON(_ arguments: [String]) async throws -> CLIInvocationResult {
        let runtime = try loadEmbeddedRuntime()
        var commandArguments = [runtime.cliEntrypoint.path]
        commandArguments.append(contentsOf: arguments)
        commandArguments.append(contentsOf: ["--home", runtime.homeDirectory.path])

        guard runtime.nodeExecutable.isFileURL, runtime.cliEntrypoint.isFileURL,
              FileManager.default.isExecutableFile(atPath: runtime.nodeExecutable.path),
              FileManager.default.isReadableFile(atPath: runtime.cliEntrypoint.path) else {
            throw TokenlessAppError.runtimeInvalid
        }

        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let outputPipe = Pipe()
            process.executableURL = runtime.nodeExecutable
            process.arguments = commandArguments
            process.standardOutput = outputPipe
            process.standardError = FileHandle.nullDevice
            var environment = ProcessInfo.processInfo.environment
            let nodeBin = runtime.nodeExecutable.deletingLastPathComponent().path
            let existingPath = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
            environment["PATH"] = "\(nodeBin):\(existingPath)"
            process.environment = environment
            process.terminationHandler = { process in
                let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: CLIInvocationResult(
                    data: data,
                    exitCode: process.terminationStatus
                ))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: TokenlessAppError.processLaunchFailed)
            }
        }
    }

    private func loadEmbeddedRuntime() throws -> EmbeddedRuntime {
        if let runtime {
            return runtime
        }
        guard let resourcesURL = Bundle.main.resourceURL else {
            throw TokenlessAppError.runtimeUnavailable
        }
        let runtimeURL = resourcesURL.appendingPathComponent("runtime", isDirectory: true)
        let nodeURL = runtimeURL.appendingPathComponent("node", isDirectory: false)
        let cliEntrypointURL = runtimeURL
            .appendingPathComponent("cli", isDirectory: true)
            .appendingPathComponent("dist", isDirectory: true)
            .appendingPathComponent("src", isDirectory: true)
            .appendingPathComponent("tokenless.mjs", isDirectory: false)
        let homeURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tokenless", isDirectory: true)
        guard FileManager.default.isExecutableFile(atPath: nodeURL.path),
              FileManager.default.isReadableFile(atPath: cliEntrypointURL.path) else {
            throw TokenlessAppError.runtimeInvalid
        }
        let loadedRuntime = EmbeddedRuntime(
            nodeExecutable: nodeURL,
            cliEntrypoint: cliEntrypointURL,
            homeDirectory: homeURL
        )
        runtime = loadedRuntime
        return loadedRuntime
    }

    private func decode<T: Decodable>(_ type: T.Type, from result: CLIInvocationResult) throws -> T {
        guard !result.data.isEmpty else {
            throw TokenlessAppError.processFailed
        }
        do {
            return try JSONDecoder().decode(type, from: result.data)
        } catch {
            throw TokenlessAppError.invalidJSON
        }
    }

    private func requireOK(_ ok: Bool?, error: CLIErrorPayload?) throws {
        guard ok == true else {
            throw TokenlessAppError.commandFailed(commandError(error, fallback: LocalizedText(
                english: "The Tokenless command failed.",
                chinese: "Tokenless 命令执行失败。"
            )))
        }
    }

    private func commandError(_ error: CLIErrorPayload?, fallback: LocalizedText) -> String {
        if let message = error?.message, !message.isEmpty {
            return sanitizedMessage(message)
        }
        return text(fallback)
    }

    private func sanitizedMessage(_ message: String) -> String {
        var value = message
        if let runtime {
            value = value.replacingOccurrences(of: runtime.homeDirectory.path, with: "Tokenless home")
            value = value.replacingOccurrences(of: runtime.nodeExecutable.path, with: "embedded Node")
            value = value.replacingOccurrences(of: runtime.cliEntrypoint.path, with: "embedded CLI")
        }
        return value.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }

    private func versionMessage(english: String, chinese: String) -> String {
        text(LocalizedText(english: english, chinese: chinese))
    }

    private func localizedError(_ error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            switch language {
            case .english:
                return description
            case .simplifiedChinese:
                guard let tokenlessError = error as? TokenlessAppError else {
                    return description
                }
                switch tokenlessError {
                case TokenlessAppError.runtimeUnavailable:
                    return "Tokenless 内置 runtime 不可用。请重新构建并安装 macOS app。"
                case TokenlessAppError.runtimeInvalid:
                    return "Tokenless 内置 runtime 无效。请重新构建并安装 macOS app。"
                case TokenlessAppError.processLaunchFailed:
                    return "Tokenless 无法启动本地 CLI。"
                case TokenlessAppError.processFailed:
                    return "Tokenless CLI 未返回可用结果。"
                case TokenlessAppError.invalidJSON:
                    return "Tokenless 返回了无效的本地响应。"
                case .commandFailed:
                    return description
                }
            }
        }
        return text(LocalizedText(
            english: "Tokenless could not complete the request.",
            chinese: "Tokenless 无法完成请求。"
        ))
    }
}

private struct MenuBarIcon: View {
    var body: some View {
        if let image = Self.templateImage {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 18, height: 18)
                .accessibilityLabel("Tokenless")
        } else {
            Image(systemName: "circle.hexagongrid.circle")
                .accessibilityLabel("Tokenless")
        }
    }

    private static var templateImage: NSImage? {
        guard let url = Bundle.main.url(forResource: "tokenless-mark", withExtension: "png"),
              let image = NSImage(contentsOf: url) else {
            return nil
        }
        // MenuBarExtra uses the NSImage's logical size for the status item label.
        // The source mark is 443x373 px, so constrain the image itself instead of
        // relying on SwiftUI's frame modifier, which MenuBarExtra may discard.
        let logicalHeight: CGFloat = 18
        guard image.size.height > 0 else { return nil }
        let scale = logicalHeight / image.size.height
        image.size = NSSize(
            width: image.size.width * scale,
            height: logicalHeight
        )
        image.isTemplate = true
        return image
    }
}

private struct MenuBarView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            feedback
            Divider()
            Button {
                model.openDashboard()
            } label: {
                Label(model.text(LocalizedText(
                    english: "Open Dashboard",
                    chinese: "打开 Dashboard"
                )), systemImage: "rectangle.inset.filled.and.person.filled")
            }
            .keyboardShortcut("d", modifiers: [.command])
            .accessibilityLabel(model.text(LocalizedText(
                english: "Open Tokenless Dashboard",
                chinese: "打开 Tokenless Dashboard"
            )))

            recentConversations
            Divider()
            maintenance
            Divider()
            Button {
                model.requestQuit()
            } label: {
                Label(model.text(LocalizedText(
                    english: "Quit Tokenless",
                    chinese: "退出 Tokenless"
                )), systemImage: "power")
            }
            .keyboardShortcut("q", modifiers: [.command])
            .accessibilityLabel(model.text(LocalizedText(
                english: "Quit Tokenless",
                chinese: "退出 Tokenless"
            )))
        }
        .padding(16)
        .frame(width: 360)
        .onAppear {
            model.refreshOnAppear()
        }
        .confirmationDialog(
            confirmationTitle,
            isPresented: Binding(
                get: { model.pendingConfirmation != nil },
                set: { isPresented in
                    if !isPresented { model.pendingConfirmation = nil }
                }
            ),
            titleVisibility: .visible
        ) {
            Button(confirmationActionTitle) {
                model.confirmPendingAction()
            }
            Button(model.text(LocalizedText(english: "Cancel", chinese: "取消")), role: .cancel) {
                model.pendingConfirmation = nil
            }
        } message: {
            Text(confirmationMessage)
        }
    }

    @ViewBuilder
    private var feedback: some View {
        if model.operationMessage != nil || model.errorMessage != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let message = model.operationMessage {
                    feedbackRow(
                        message: message,
                        icon: "info.circle",
                        color: .secondary
                    )
                    .accessibilityLabel(model.text(LocalizedText(
                        english: "Status: \(message)",
                        chinese: "状态：\(message)"
                    )))
                    .accessibilityAddTraits(.updatesFrequently)
                }
                if let message = model.errorMessage {
                    feedbackRow(
                        message: message,
                        icon: "exclamationmark.triangle.fill",
                        color: .red
                    )
                    .accessibilityLabel(model.text(LocalizedText(
                        english: "Error: \(message)",
                        chinese: "错误：\(message)"
                    )))
                    .accessibilityAddTraits(.isStaticText)
                    .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func feedbackRow(message: String, icon: String, color: Color) -> some View {
        Label {
            Text(message)
                .font(.caption)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: icon)
                .foregroundStyle(color)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            MenuBarIcon()
            VStack(alignment: .leading, spacing: 3) {
                Text("Tokenless")
                    .font(.headline)
                HStack(spacing: 5) {
                    Circle()
                        .fill(model.daemonIsRunning ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    Text(statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let version = model.version {
                        Text("· v\(version)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if model.activeJobCount > 0 {
                    Text(model.text(LocalizedText(
                        english: "\(model.activeJobCount) active job(s)",
                        chinese: "\(model.activeJobCount) 个 active job"
                    )))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if model.isRefreshing {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(model.text(LocalizedText(
                        english: "Refreshing",
                        chinese: "正在刷新"
                    )))
            }
        }
    }

    private var recentConversations: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.text(LocalizedText(
                english: "RECENT CONVERSATIONS",
                chinese: "最近对话"
            )))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)

            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if model.conversations.isEmpty {
                        Text(model.text(LocalizedText(
                            english: "No recent conversations",
                            chinese: "暂无最近对话"
                        )))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                    } else {
                        ForEach(model.conversations) { conversation in
                            Button {
                                model.openDashboard(
                                    jobId: conversation.jobId,
                                    profileSlug: conversation.profileSlug
                                )
                            } label: {
                                ConversationRow(conversation: conversation, language: model.language)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(conversation.title)
                        }
                    }
                }
            }
            .frame(maxHeight: 216)
            .scrollIndicators(.automatic)

            Button {
                model.openDashboard()
            } label: {
                Text(model.text(LocalizedText(
                    english: "View All Conversations…",
                    chinese: "查看全部对话…"
                )))
                .font(.callout)
            }
            .buttonStyle(.link)
        }
    }

    private var maintenance: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button {
                model.requestRestart()
            } label: {
                Label(model.text(LocalizedText(
                    english: "Restart Tokenless",
                    chinese: "重启 Tokenless"
                )), systemImage: "arrow.clockwise")
            }
            .disabled(model.updateState.isBusy)

            updateButton

            Toggle(isOn: Binding(
                get: { model.launchAtLogin },
                set: { model.setLaunchAtLogin($0) }
            )) {
                Label(model.text(LocalizedText(
                    english: "Start Tokenless at Login",
                    chinese: "登录时启动 Tokenless"
                )), systemImage: "rectangle.portrait.and.arrow.forward")
            }
            .toggleStyle(.checkbox)
        }
    }

    @ViewBuilder
    private var updateButton: some View {
        switch model.updateState {
        case .available(let version):
            Button {
                model.upgrade()
            } label: {
                Label(model.text(LocalizedText(
                    english: "Upgrade to \(version ?? "latest")",
                    chinese: "升级到 \(version ?? "latest")"
                )), systemImage: "arrow.down.circle")
            }
        case .checking:
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text(model.text(LocalizedText(
                    english: "Checking for Updates…",
                    chinese: "正在检查更新…"
                )))
                .font(.callout)
            }
        case .upgrading:
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text(model.text(LocalizedText(
                    english: "Upgrading…",
                    chinese: "正在升级…"
                )))
                .font(.callout)
            }
        default:
            Button {
                model.checkForUpdates()
            } label: {
                Label(model.text(LocalizedText(
                    english: "Check for Updates…",
                    chinese: "检查更新…"
                )), systemImage: "arrow.triangle.2.circlepath")
            }
        }
        if let updateMessage = model.updateMessage {
            Text(updateMessage)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var statusText: String {
        model.daemonIsRunning
            ? model.text(LocalizedText(english: "Running", chinese: "运行中"))
            : model.text(LocalizedText(english: "Unavailable", chinese: "不可用"))
    }

    private var confirmationTitle: String {
        switch model.pendingConfirmation {
        case .restart:
            return model.text(LocalizedText(
                english: "Restart Tokenless?",
                chinese: "要重启 Tokenless 吗？"
            ))
        case .quit:
            return model.text(LocalizedText(
                english: "Quit Tokenless?",
                chinese: "要退出 Tokenless 吗？"
            ))
        case nil:
            return ""
        }
    }

    private var confirmationActionTitle: String {
        switch model.pendingConfirmation {
        case .restart:
            return model.text(LocalizedText(english: "Restart", chinese: "重启"))
        case .quit:
            return model.text(LocalizedText(english: "Quit", chinese: "退出"))
        case nil:
            return ""
        }
    }

    private var confirmationMessage: String {
        model.text(LocalizedText(
            english: "There are active jobs. Stopping Tokenless may interrupt them.",
            chinese: "当前有 active job。停止 Tokenless 可能会中断它们。"
        ))
    }
}

private struct ConversationRow: View {
    let conversation: MenuBarConversation
    let language: SnapshotLanguage

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title)
                    .font(.callout)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(conversation.provider)
                    Text("·")
                    Text(relativeDate)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 5)
        .padding(.horizontal, 4)
    }

    private var statusColor: Color {
        switch conversation.status {
        case "succeeded":
            return .green
        case "failed", "canceled", "timed_out":
            return .red
        case "waiting_for_user":
            return .orange
        default:
            return .secondary
        }
    }

    private var relativeDate: String {
        guard let date = ISO8601DateFormatter().date(from: conversation.updatedAt) else {
            return conversation.updatedAt
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = language.locale
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

@main
struct TokenlessMenuBarApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(model: model)
        } label: {
            MenuBarIcon()
        }
        .menuBarExtraStyle(.window)
    }
}
