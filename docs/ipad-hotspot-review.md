# iPad Hotspot review fix

The shared UI previously offered Start Hotspot on iOS, but the iOS app has no Hotspot plugin. iOS now shows manual network setup, explains the cellular/carrier requirements and Wi-Fi-only iPad limitation, and provides Send files and Receive files navigation. Native hotspot startup remains available on Android.

Apple platform references:
- https://developer.apple.com/forums/thread/113933
- https://support.apple.com/en-au/guide/ipad/ipadb2c87b68/ipados

## Required device validation before resubmission

- Build the updated iOS app (Codemagic runs `npx cap sync ios` to package www).
- Test a clean install and an update from the rejected version on iPad Air 11-inch (M3), iPadOS 26.6.1 when available.
- Open the Hotspot card: manual instructions must appear; Start/Stop Hotspot and an assumed On/Off state must not appear.
- On a Wi-Fi-only iPad, join the same Wi-Fi network as a second device. Use the card's Send files and Receive files buttons and complete a transfer in both directions. Compare the received files with the originals.
- On a cellular device with a supported plan, enable Personal Hotspot in Settings, connect the other device, and complete transfers. The app must not claim it enabled or detected Personal Hotspot.
- Check Local Network permission granted and denied, offline behavior, background/foreground return, and transfer cancellation.
- Smoke-test Android Start/Stop Hotspot on hardware.
- Update App Store screenshots/description if they imply that the iOS app creates a hotspot automatically.

Automated verification: `npm test` includes the Hotspot platform regression and inline JavaScript syntax check. Device testing and an iOS build were not performed in the Windows workspace.
