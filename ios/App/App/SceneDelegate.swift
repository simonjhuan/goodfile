import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // Cold start from the share sheet ("Copy to goodfile" / "Open in goodfile").
        SharedInbox.shared.receive(connectionOptions.urlContexts.map { $0.url })
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let urls = URLContexts.map { $0.url }
        SharedInbox.shared.receive(urls)
        let others = URLContexts.filter { !$0.url.isFileURL }
        if !others.isEmpty {
            SceneDelegateProxy.shared.scene(scene, openURLContexts: others)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

final class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FileServerPlugin())
        bridge?.registerPluginInstance(DownloaderPlugin())
    }
}
