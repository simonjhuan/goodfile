/* ============================================================
   goodfile — lightweight runtime i18n (TH source → EN)
   - dict: Thai phrase -> English
   - tr(): replaces every known Thai phrase inside any string
           (works for interpolated toasts, status, built HTML)
   - walks DOM + MutationObserver translates dynamic content
   - keeps the original Thai so the EN/TH switch is reversible
   - default EN, auto-detect device language, remembers choice
   ============================================================ */
(function(){
  var DICT = {
    // ---- single words / short labels ----
    "ไฟล์":"file","สแกน":"Scan","แชร์":"Share","โหลด":"Download","พร้อม":"Ready",
    "ล้าง":"Clear","นาที":"min","ครั้ง":"times","สำเร็จ":"Done","บันทึก":"Save",
    "ยกเลิก":"Cancel","หมดอายุ":"Expired","รอรับ":"Waiting","รับแล้ว":"Received",
    "ปิดอยู่":"Off","เปิดอยู่":"On","ว่างเปล่า":"Empty","ไม่รองรับ":"Not supported",
    "ไม่มีไฟล์":"No file","เลือกไฟล์":"Choose a file","รับไฟล์":"Receive file",
    "แชร์ไฟล์":"Share file","ไม่หมดอายุ":"No expiry","พอร์ตไม่ขึ้น":"Port failed",
    "1 ชม.":"1 hr","5 นาที":"5 min","15 นาที":"15 min","30 นาที":"30 min",
    "จำกัด DL":"Limit DL","ไฟล์...":"files...","ตั้งข้อความ":"Set text",
    "ไม่มีข้อความ":"No text","ยังไม่มีข้อความ":"No text yet","ข้อความ":"text",
    // ---- connection status: whether the two devices can actually reach each other ----
    // Full phrases only. tr() substitutes any known Thai substring, so a partial
    // entry yields half-translated text like "เซิร์ฟเวอร์Ready".
    "กำลังตรวจสอบการเชื่อมต่อ…":"Checking the connection…",
    "เซิร์ฟเวอร์พร้อม · รอเครื่องอื่นสแกน":"Server ready · waiting for the other device",
    "เครื่องนี้อยู่วง":"This device is on",
    "— อีกเครื่องต้องอยู่ WiFi ชื่อเดียวกัน":"— the other device must be on the same WiFi",
    "📱 อีกเครื่องเชื่อมต่อแล้ว ✓":"📱 Other device connected ✓",
    "📱 อีกเครื่องเชื่อมต่อแล้ว":"📱 Other device connected",
    "เชื่อมถึงกันได้จริง กำลังรับไฟล์":"They can reach each other — transferring",
    "ยังไม่มีเครื่องไหนเชื่อมต่อ":"No device has connected yet",
    "อีกเครื่องอาจอยู่คนละ WiFi หรือ WiFi นี้บล็อกการเชื่อมต่อ":"The other device may be on a different WiFi, or this WiFi blocks device-to-device traffic",
    "⚠️ ยังไม่มีเครื่องไหนเชื่อมต่อเข้ามา":"⚠️ Nothing has connected to you yet",
    "ถ้าอีกเครื่องสแกนแล้วหน้าเว็บค้าง แปลว่าสองเครื่องยังคุยกันไม่ได้":"If the other device scans and the page just hangs, the two devices can't reach each other",
    "1. เช็คว่าทั้งสองเครื่องต่อ WiFi ชื่อเดียวกัน (2.4G กับ 5G ถือว่าคนละวง)":"1. Check both devices are on the same WiFi name (2.4G and 5G count as different networks)",
    "2. ปิดเน็ตมือถือของเครื่องที่ส่ง แล้วกดทดสอบใหม่":"2. Turn off mobile data on the sending device, then tap Test again",
    "3. WiFi โรงแรม ร้านกาแฟ ออฟฟิศ มักบล็อกไม่ให้เครื่องคุยกัน":"3. Hotel, café and office WiFi often block devices from talking to each other",
    "4. เปิด Hotspot จากเครื่องส่ง แล้วให้อีกเครื่องมาต่อ วิธีนี้ได้ผลเสมอ":"4. Turn on Hotspot from the sending device and connect the other to it — this always works",
    "ต่ออยู่กับเน็ตมือถือ ไม่ใช่ WiFi":"On mobile data, not WiFi",
    "เชื่อม WiFi เดียวกันกับเครื่องรับก่อน แล้วกด “ทดสอบ”":"Join the same WiFi as the receiver, then tap “Test”",
    "มีคนสแกน QR เก่า":"Someone scanned an old QR",
    "QR ที่เขาสแกนเป็นของรายการก่อนหน้า — ให้เลือกไฟล์ใหม่แล้วให้สแกน QR อันล่าสุด":"They scanned a QR from an earlier transfer — pick the file again and let them scan the new QR",
    "⚠️ QR ที่สแกนเป็นอันเก่า — ให้สแกนอันใหม่":"⚠️ That QR is out of date — scan the new one",
    "📡 เครือข่ายเปลี่ยน — อัปเดต QR แล้ว":"📡 Network changed — QR updated",
    // ---- one-tap send to a nearby receiver (no QR) ----
    "⚡ ส่งตรงถึงเครื่องใกล้เคียง":"⚡ Send straight to a nearby device",
    "ไม่ต้องสแกน QR":"no QR needed",
    "ส่ง ›":"Send ›",
    "★ เคยส่ง":"★ used before",
    "กำลังส่งไปที่":"Sending to",
    "กำลังส่ง":"Sending",
    "กำลังส่งอยู่":"Already sending",
    "ได้รับไฟล์แล้ว":"received the file",
    "ส่งตรงไม่สำเร็จ":"Direct send failed",
    "ให้อีกเครื่องสแกน QR แทน":"Have the other device scan the QR instead",
    "❌ ส่งตรงไม่สำเร็จ — ใช้ QR แทนได้":"❌ Direct send failed — use the QR instead",
    "ส่งตรงไม่ได้ — ใช้ QR แทน":"Can't send directly — use the QR",
    "✅ ส่งถึง":"✅ Delivered to",
    "อีกเครื่อง":"the other device",
    // ---- home screen (global redesign) ----
    "ส่งไฟล์ ง่ายๆ":"Send files, simply.",
    "เร็ว เป็นส่วนตัว ส่งตรงระหว่างเครื่อง":"Fast, private, device to device",
    "เลือกไฟล์":"Choose files",
    "รูป วิดีโอ เอกสาร โฟลเดอร์":"Photos, videos, documents, folders",
    "ส่งข้อความ":"Share text",
    "หรือส่งข้อความแทน":"Or send text instead",
    "ไม่ผ่านคลาวด์":"No cloud",
    "ไม่จำกัดขนาด":"No limits",
    "ส่วนตัว":"Private",
    "ทุกแพลตฟอร์ม":"Any platform",
    "ส่งไฟล์":"Send files",
    "เลือกรูป วิดีโอ หรือเอกสาร":"Choose photos, videos, or documents",
    "↓ รับไฟล์จากอีกเครื่อง":"↓ Receive files",
    "ไม่ลดคุณภาพ":"Original quality",
    "รับไฟล์ใน 3 ขั้นตอน":"Receive in 3 steps",
    "ให้อีกเครื่องต่อ Wi-Fi เดียวกัน":"Connect the other device to the same Wi-Fi",
    "สแกน QR ที่เห็นด้านบน":"Scan the QR above",
    "กดดาวน์โหลด รับไฟล์ได้ทันที ✓":"Tap download to receive instantly ✓",
    // ---- PC browser -> Android, four-digit pairing ----
    "PC เปิด gf.maew0009.workers.dev":"On PC, open gf.maew0009.workers.dev",
    "กำลังสร้างรหัส 4 ตัว...":"Creating a 4-digit code...",
    "สร้างรหัสใหม่":"Create a new code",
    "หรือใช้ QR ใน Wi-Fi เดียวกัน":"or use the QR on the same Wi-Fi",
    "กำลังเปิดเครื่องรับไฟล์...":"Starting the file receiver...",
    "PC กรอกรหัสนี้ แล้วเลือกไฟล์":"Enter this code on the PC, then choose a file",
    "ใช้ได้ 5 นาที · ลองซ้ำได้":"Valid for 5 minutes · retry if needed",
    "หมดอายุใน":"Expires in",
    "รหัสหมดอายุแล้ว — กดสร้างรหัสใหม่":"Code expired — create a new code",
    "PC เชื่อมต่อแล้ว — รอเลือกและส่งไฟล์":"PC connected — choose and send a file",
    "เชื่อมตรงผ่าน Wi-Fi เดียวกัน":"Direct over the same Wi-Fi",
    "สร้างรหัสออนไลน์ไม่ได้ — ใช้ QR หรือ URL ด้านล่าง":"Could not create an online code — use the QR or URL below",
    "ตรวจอินเทอร์เน็ตแล้วลองใหม่":"Check the internet connection and try again",
    "รับไฟล์สำเร็จ":"File received",
    "กดสร้างรหัสใหม่เพื่อรับไฟล์ถัดไป":"Create a new code to receive another file",
    "รหัส 4 ตัวรองรับ Android เท่านั้น":"The 4-digit code is available on Android only",
    "ฟีเจอร์นี้ใช้ได้เฉพาะแอป Android":"This feature requires the Android app",
    "เปิดพอร์ตรับไฟล์ไม่ได้":"Could not start the file receiver",
    "ตรวจตามนี้ แล้วลองสแกน QR ล่าสุดอีกครั้ง":"Check these, then scan the latest QR again",
    "1. ตรวจว่า Wi-Fi บนทั้งสองเครื่องเป็นชื่อเดียวกัน":"1. Check both devices use the same Wi-Fi name",
    "2. ปิด VPN ชั่วคราว แล้วลองอีกครั้ง":"2. Turn off VPN temporarily and try again",
    "3. ถ้ายังไม่ได้ ลองใช้ Hotspot จากเครื่องหนึ่ง":"3. If it still fails, use a hotspot from one device",
    "ให้อีกเครื่องเชื่อมต่อ Hotspot แล้วสแกนใหม่":"Connect the other device to the hotspot and scan again",
    "หน้าหลัก":"Home",
    "รับไฟล์":"Receive",
    "กิจกรรม":"Activity",
    // ---- settings sheet ----
    "ตั้งค่า":"Settings",
    "ภาษา":"Language",
    "โหมดสว่าง":"Light mode",
    "สลับพื้นหลังสว่าง/มืด":"Switch between light and dark",
    "ส่งทั้งโฟลเดอร์":"Send a whole folder",
    "รวมเป็นไฟล์ zip ก่อนส่ง":"Zipped before sending",
    "รายงานปัญหา":"Report a problem",
    "ส่งบันทึกในเครื่องให้ผู้พัฒนา":"Send the on-device log to the developer",
    "เลือก":"Choose",
    "ส่ง":"Send",
    // ---- home screen: secondary tools + theme ----
    "เครื่องมือเพิ่มเติม":"More tools",
    "🟩 ธีมแฮกเกอร์":"🟩 Hacker theme",
    "พื้นหลังตัวอักษรตกแบบ Matrix (ปิดไว้เพื่อให้อ่านง่ายและประหยัดแบต)":"Falling Matrix characters (off by default for readability and battery)",
    "ส่งตรงแบบไม่ผ่าน WiFi ร่วม สำหรับ iPhone หรือเมื่อไม่มีเราเตอร์":"Send without a shared WiFi — for iPhone, or when there's no router",
    "เปิด":"Open",
    // ---- problem reporting (on-device log, user-initiated) ----
    "📋 รายงานปัญหา":"📋 Report a problem",
    "ขอบคุณครับ 🙏":"Thank you 🙏",
    "คัดลอกรายงานแล้ว — วางในแชตส่งมาได้เลย":"Report copied — paste it into a chat to send",
    "ส่งรายงานไม่ได้":"Couldn't send the report",
    "ไม่มีข้อมูลบันทึก":"No log recorded",
    // ---- statuses / pills ----
    "QR พร้อม":"QR ready","✅ QR พร้อม":"✅ QR ready","⚡ QR พร้อม!":"⚡ QR ready!",
    "✅ ครบ":"✅ All set","พร้อมให้สแกน":"Ready to scan","พร้อมให้สแกน":"Ready to scan",
    "⏱ ไม่หมดอายุ":"⏱ No expiry","⏱ Link หมดอายุแล้ว":"⏱ Link expired",
    "QR พร้อมแชร์ 📡":"QR ready to share 📡","✅ พร้อม download":"✅ Ready to download",
    "📥 พร้อมรับไฟล์":"📥 Ready to receive","⚡ พร้อมส่งทันที":"⚡ Ready to send",
    // ---- send flow ----
    "↑ ส่ง":"↑ Send","↓ รับ":"↓ Receive","📥 รับ":"📥 Receive","↑ แชร์":"↑ Share",
    "👁️ ดู":"👁️ Open","↓ ไม่จำกัด":"↓ Unlimited","⏳ รวม":"⏳ Merging","⏳ เตรียม...":"⏳ Preparing...",
    "📦 กำลัง zip":"📦 Zipping","📦 หลายไฟล์:":"📦 Multiple files:","⏳ ไฟล์ใหญ่...":"⏳ Large file...",
    "👆 ลองเลือกไฟล์เลย!":"👆 Pick a file!","เลือกไฟล์ก่อน":"Choose a file first",
    "เลือกไฟล์อื่น":"Choose another file","เลือกไฟล์ไม่ได้":"Could not pick file",
    "ส่งทั้งโฟลเดอร์ (zip)":"Send whole folder (zip)","ส่งสำเร็จ":"Sent","ส่งสำเร็จ! 🎉":"Sent! 🎉",
    "✅ ส่งไฟล์สำเร็จ!":"✅ File sent!","· ส่งสำเร็จ! 🎉":"· Sent! 🎉",
    // ---- receive flow ----
    "รับสำเร็จ":"Received","รับไฟล์สำเร็จ!":"File received!","รับไฟล์สำเร็จ! ✨":"File received! ✨",
    "✅ รับไฟล์:":"✅ Received:","📥 ไฟล์ที่รับมา":"📥 Received files","📥 รับไฟล์จากเครื่องอื่น":"📥 Receive from another device",
    "กำลังรับ...":"Receiving...","ยังไม่มีไฟล์ที่รับมา":"No received file yet",
    "ให้อีกเครื่องสแกน":"Let the other device scan","ให้เครื่องส่ง scan QR นี้":"Have the sender scan this QR",
    "แตะ Download เพื่อรับไฟล์":"Tap Download to receive","แล้วกด Upload เพื่อส่งไฟล์มาหาคุณ":"then tap Upload to send you a file",
    "⬇ Download ในแอป":"⬇ Download in app","⬇ กำลังโหลด:":"⬇ Downloading:","กำลังโหลด...":"Loading...",
    "✅ โหลดสำเร็จ:":"✅ Downloaded:","โหลดสำเร็จ":"Downloaded","โหลดเสร็จ":"Download done",
    "❌ โหลดล้มเหลว:":"❌ Download failed:",
    // ---- file view / open / save ----
    "⏳ กำลังเปิด...":"⏳ Opening...","✅ เปิดไฟล์แล้ว":"✅ File opened","✅ เปิดรูปแล้ว":"✅ Image opened",
    "✅ เปิด PDF แล้ว":"✅ PDF opened","✅ กดเล่น vdo ได้เลย":"✅ Tap to play video","✅ กดเล่น audio ได้เลย":"✅ Tap to play audio",
    "เปิดด้วยแอปอื่นไม่ได้ — ลองดูในแอป":"Can't open externally — viewing in app","❌ viewer ไม่พบ":"❌ Viewer not found",
    "⏳ กำลังอ่านไฟล์...":"⏳ Reading file...","อ่านไฟล์ไม่ได้":"Can't read file","❌ อ่านไฟล์ไม่ได้":"❌ Can't read file",
    "❌ อ่านไฟล์ไม่ได้:":"❌ Can't read file:","❌ อ่านไฟล์ไม่สำเร็จ":"❌ Failed to read file","⚠️ อ่านไม่ได้:":"⚠️ Can't read:",
    "❌ อ่านรูปไม่ได้":"❌ Can't read image","⏳ กำลังบันทึก":"⏳ Saving","⏳ กำลังบันทึก...":"⏳ Saving...",
    "บันทึกแล้ว":"Saved","✅ บันทึกแล้ว":"✅ Saved","✅ บันทึกที่:":"✅ Saved to:","บันทึกที่:":"Saved to:","กำลังบันทึก...":"Saving...","❌ บันทึกไม่ได้":"❌ Can't save",
    "⏳ กำลังบันทึกไป Downloads...":"⏳ Saving to Downloads...","ไม่สามารถเขียนไฟล์ได้:":"Can't write file:",
    "📂 ที่อยู่ไฟล์":"📂 File path","📋 Copy path แล้ว":"📋 Path copied","✅ Copy path แล้ว":"✅ Path copied",
    "⚠️ ไม่ทราบ path ของไฟล์":"⚠️ Unknown file path","⚠️ ไม่ทราบตำแหน่งไฟล์ — ลองกดแชร์แทน":"⚠️ Unknown file location — try Share",
    "⚠️ ไม่ทราบตำแหน่งไฟล์":"⚠️ Unknown file location","⚠️ Plugin ไม่ส่ง path กลับมา":"⚠️ Plugin returned no path",
    "(plugin ไม่ส่ง path มา — ดูที่ Android/data/com.goodfile.app/cache/)":"(no path from plugin — see Android/data/com.goodfile.app/cache/)",
    // ---- share ----
    "✅ แชร์สำเร็จ":"✅ Shared","แชร์สำเร็จ":"Shared","แชร์เรียบร้อย":"Shared","แชร์ไฟล์เรียบร้อย":"File shared",
    "❌ แชร์ไม่ได้:":"❌ Can't share:","แชร์ clipboard":"Share clipboard","แชร์ Clipboard! 🚀":"Share clipboard! 🚀",
    // ---- clipboard / paste ----
    "Copy แล้ว":"Copied","Copy แล้ว 📋":"Copied 📋","✅ Copy แล้ว!":"✅ Copied!","Copy URL แล้ว":"URL copied",
    "✅ Copy URL แล้ว!":"✅ URL copied!","ยังไม่มี URL":"No URL yet","ยังไม่มี link":"No link yet",
    "Paste สำเร็จ":"Pasted","Paste สำเร็จ ✓":"Pasted ✓","✅ Paste สำเร็จ":"✅ Pasted","Paste สำเร็จ ✓":"Pasted ✓",
    "ตั้งข้อความ":"Set text","✅ ตั้งข้อความแล้ว":"✅ Text set","กำลังดึง...":"Fetching...","❌ ดึงไม่ได้":"❌ Can't fetch",
    "✅ ดึง clipboard สำเร็จ!":"✅ Clipboard fetched!","ข้อความพร้อมแชร์":"Text ready to share","ข้อความพร้อมแชร์":"Text ready to share",
    "อยู่ใน clipboard":"in clipboard","จาก clipboard เครื่องนี้":"from this device's clipboard","ล้าง clipboard แล้ว":"Clipboard cleared",
    "❌ ไม่มีข้อความ":"❌ No text","📋 Paste ข้อความที่นี่ (กดค้าง → Paste)":"📋 Paste text here (long-press → Paste)",
    "กดค้างที่ช่องนี้ → เลือก Paste...":"Long-press here → Paste...","✓ ใช้ข้อความนี้":"✓ Use this text",
    "💡 กดค้างในช่อง → เลือก Paste":"💡 Long-press the field → Paste","💡 Safari เปิดไฟล์แล้ว — กดค้างที่ไฟล์ → บันทึก":"💡 Safari opened the file — long-press it → Save",
    // ---- QR / scan ----
    "✅ สแกนได้!":"✅ Scanned!","✅ สแกนสำเร็จ":"✅ Scan complete","สแกน QR สำเร็จ! 🎯":"QR scan complete! 🎯",
    "พบ QR code แล้ว":"QR code found","❌ QR ไม่ใช่ URL":"❌ QR is not a URL","❌ ไม่พบ QR ในรูป":"❌ No QR in image",
    "📷 สแกนจากรูปภาพ":"📷 Scan from image","📷 สแกน QR จากฝั่งส่ง":"📷 Scan sender's QR","✅ QR พร้อม — IP:":"✅ QR ready — IP:",
    "✅ Answer QR พร้อม":"✅ Answer QR ready","QR พร้อมแชร์ 📡":"QR ready to share 📡",
    // ---- history / misc ----
    "ล้างประวัติแล้ว":"History cleared","ล้างประวัติทั้งหมด?":"Clear all history?","ล้างประวัติทั้งหมด":"Clear all history",
    "ยกเลิก auto-receive":"Auto-receive cancelled","(ไม่มีรหัส)":"(no code)","· เหลือ ~":"· ~","เพื่อป้องกันเด้ง":"to prevent dropping",
    "🌐 เปิดใน Browser":"🌐 Open in Browser","กำลังเชื่อมต่อ...":"Connecting...","กำลังดึง IP...":"Getting IP...",
    "เชื่อมต่อแล้ว! กำลังส่ง...":"Connected! Sending...","✅ เชื่อมต่อ! รอ DataChannel...":"✅ Connected! Waiting for DataChannel...",
    "อุปกรณ์อื่นเชื่อมต่อได้แล้ว":"Other device connected","ให้อีกเครื่องสแกน":"Let the other device scan",
    // ---- network / hotspot / wifi-direct ----
    "ต้องอยู่ WiFi เดียวกัน":"Must be on the same WiFi","ต้องสแกน QR หรือใส่ URL ก่อน":"Scan a QR or enter a URL first",
    "Hotspot เปิด":"Hotspot on","Hotspot เปิดแล้ว! 📡":"Hotspot on! 📡","Hotspot ปิดแล้ว":"Hotspot off","เปิด Hotspot ไม่ได้":"Can't enable Hotspot",
    "📡 Hotspot เปิดแล้ว! ให้ฝั่งรับต่อ WiFi:":"📡 Hotspot on! Have the receiver join WiFi:",
    "ไม่พบ — เชื่อม WiFi Direct ก่อน":"Not found — connect WiFi Direct first","ไปที่ Settings → WiFi → WiFi Direct":"Go to Settings → WiFi → WiFi Direct",
    "🔍 สแกน IP...":"🔍 Scanning IP...","📡 กำลังค้นหา...":"📡 Searching...","🔍 กำลังสแกน 192.168.49.1-20...":"🔍 Scanning 192.168.49.1-20...",
    "📡 กำลังค้นหาอุปกรณ์ใกล้เคียง...":"📡 Searching nearby devices...","ไม่พบอุปกรณ์ใน WiFi Direct subnet":"No devices on the WiFi Direct subnet",
    "timeout — เครื่อง I/O ช้า":"timeout — slow device I/O",
    // ---- connection status banner (sender QR screen) ----
    "ทดสอบ":"Test","กำลังตรวจการเชื่อมต่อ…":"Checking connection…",
    "พร้อมเชื่อมแล้ว ✓":"Ready to connect ✓",
    "ให้ปลายทางต่อ WiFi เดียวกัน แล้วสแกน QR":"Have the other device join the same WiFi, then scan the QR",
    "ไม่มีเครือข่าย":"No network",
    "เปิด WiFi หรือเปิด Hotspot ก่อน แล้วกด “ทดสอบ”":"Turn on WiFi or Hotspot first, then tap “Test”",
    "เชื่อมไม่ได้":"Can't connect",
    "เซิร์ฟเวอร์ไม่ตอบ — เครือข่ายนี้อาจบล็อกการเชื่อม ลองสลับไป Hotspot แล้วกด “ทดสอบ”":"Server isn't responding — this network may block device-to-device connections. Try Hotspot, then tap “Test”",
    "เครื่องอื่นรับไฟล์แล้ว ✓":"Another device got the file ✓","อีกเครื่องรับไฟล์แล้ว! 🎉":"Another device got it! 🎉",
    // ---- p2p / codes ----
    "❌ Code ไม่ถูกต้อง":"❌ Invalid code","กรุณาใส่ Offer Code":"Please enter the Offer Code","กรุณาใส่ Answer Code":"Please enter the Answer Code",
    "❌ ยังไม่ได้สร้าง Offer":"❌ Offer not created yet","⚠️ ไม่พบ ICE credentials":"⚠️ ICE credentials not found",
    "📱 iPhone: กด \"Create Connection Code\" แล้วให้ฝั่งรับสแกน QR":"📱 iPhone: tap \"Create Connection Code\", then have the receiver scan the QR",
    // ---- plugin / system errors ----
    "JSZip ไม่พบ":"JSZip not found","❌ Filesystem ไม่พบ":"❌ Filesystem not found","Filesystem ไม่ตอบสนอง":"Filesystem not responding",
    "Filesystem plugin ไม่พบ":"Filesystem plugin not found","❌ Filesystem plugin ไม่พบ":"❌ Filesystem plugin not found",
    "❌ Share plugin ไม่พบ":"❌ Share plugin not found","❌ Clipboard ไม่รองรับ":"❌ Clipboard not supported",
    "❌ HotspotPlugin ไม่พบ":"❌ HotspotPlugin not found","กล้องไม่ทำงาน:":"Camera not working:","❌ กล้องไม่รองรับ":"❌ Camera not supported",
    "❌ เปิดพอร์ตรับไฟล์ไม่ได้:":"❌ Can't open receive port:","❌ ฟีเจอร์รับไฟล์ใช้ได้เฉพาะในแอป":"❌ Receiving works only in the app",
    "ไฟล์ใหญ่เกิน 2 GB — Android filesystem อาจไม่รองรับ":"File over 2 GB — Android filesystem may not support it",
    "appendFile ไม่รองรับ — ลอง update Capacitor Filesystem":"appendFile unsupported — try updating Capacitor Filesystem",
    // ---- battery optimization ----
    "⚡ เปิดตั้งค่าแบตเตอรี่":"⚡ Open battery settings","\"ไม่ได้รับการเพิ่มประสิทธิภาพ\"":"\"Not optimized\"",
    "ไปที่ ตั้งค่า → แบตเตอรี่ → เพิ่มประสิทธิภาพ → goodfile → ปิด":"Go to Settings → Battery → Optimization → goodfile → Off",
    "ไปที่ การตั้งค่า → แบตเตอรี่ → การเพิ่มประสิทธิภาพแบตเตอรี่ → ค้นหา goodfile → เลือก":"Go to Settings → Battery → Battery optimization → find goodfile → select",
    // ---- iPhone help block ----
    "iPhone รับไฟล์ได้ 2 วิธี":"2 ways for iPhone to receive","สแกน QR จากฝั่งส่ง → Safari จะดาวน์โหลดให้อัตโนมัติ":"Scan the sender's QR → Safari downloads automatically",
    "ไปที่ ⚡ Direct → Receive → สแกน QR จากฝั่งส่ง":"Go to ⚡ Direct → Receive → scan the sender's QR",
    "เลือกไฟล์แล้วแอปจะพาไปที่":"pick a file and the app takes you to","อัตโนมัติ — ให้ฝั่งรับสแกน QR หรือ scan QR จากฝั่งส่งแล้วกด Download ใน Safari":"automatically — have the receiver scan the QR, or scan the sender's QR and tap Download in Safari",
    // ---- toasts (newly localized from hard-coded EN) ----
    "ใส่ URL ก่อน":"Enter a URL",
    "คัดลอก Offer Code":"Copy offer code","คัดลอก Answer Code":"Copy answer code",
    "✅ สแกนแล้ว — กำลังตรวจเครื่องส่ง...":"✅ Scanned — checking sender...",
    "✅ พบเครื่องส่ง — กำลังดาวน์โหลด...":"✅ Sender found — downloading...",
    "❌ ไม่พบเครื่องส่ง — ต่อ WiFi เดียวกับเครื่องส่ง หรือใช้โหมด Hotspot":"❌ Sender not reachable — join the same WiFi as the sender, or use Hotspot mode",
    "✅ WiFi เดียวกัน — เชื่อมตรงได้เร็ว":"✅ Same WiFi network — fast direct connection",
    "⚠️ คนละเครือข่าย — ลองลิงก์ตรง อาจใช้เวลา ~10 วิ":"⚠️ Different networks — trying direct link, may take ~10s",
    "❌ คนละ WiFi — ต่อ WiFi เดียวกับอีกเครื่อง หรือใช้โหมด Hotspot":"❌ Different WiFi — join the same WiFi as the other device, or use Hotspot mode",
    "❌ เชื่อมในเครือข่ายไม่สำเร็จ — ปิดแล้วเปิดแอปใหม่ทั้งสองเครื่อง แล้วลองอีกครั้ง":"❌ Connection failed on local network — close and reopen the app on both devices, then retry",
    "❌ ลิงก์ตรงถูกบล็อก (เครือข่ายมือถือ) — ต่อ WiFi เดียวกัน หรือใช้โหมด Hotspot":"❌ Direct link blocked (mobile carrier network) — join the same WiFi, or use Hotspot mode",
    "❌ เชื่อมต่อไม่ได้ — ต่อ WiFi เดียวกัน หรือใช้โหมด Hotspot":"❌ Could not connect — join the same WiFi, or use Hotspot mode",
    "⚠️ ไม่มีเครือข่าย — เปิด WiFi หรือใช้โหมด Hotspot (ใช้ได้โดยไม่ต้องมีเน็ต)":"⚠️ No network — turn on WiFi, or use Hotspot mode (works without internet)",
    "⚠️ เครือข่ายหลุด — WiFi ตัดการเชื่อมต่อ":"⚠️ Network lost — WiFi disconnected",
    "✅ กลับมาออนไลน์แล้ว":"✅ Back online",
    // ---- bits used in interpolation ----
    "วิ":"s"
  };

  var GF = window.GF_I18N = { lang:'en', dict:DICT, re:null };

  function detect(){
    // saved choice wins; otherwise default to English (global-first). Thai via toggle.
    try { var s = localStorage.getItem('gf_lang'); if (s==='en'||s==='th') return s; } catch(e){}
    return 'en';
  }

  function buildRe(){
    var keys = Object.keys(DICT).filter(function(k){return k.length;})
      .sort(function(a,b){return b.length - a.length;}) // longest first
      .map(function(k){return k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');});
    GF.re = new RegExp(keys.join('|'), 'g');
  }

  GF.tr = function(s){
    if (GF.lang === 'th' || !s || !/[฀-๿]/.test(s)) return s;
    return s.replace(GF.re, function(m){ return DICT[m] || m; });
  };
  var tr = GF.tr;

  // __o = original source (captured once / on real external change). __t = last value we wrote.
  function applyText(node){                       // render from stored original (reversible)
    if (node.__o === undefined) node.__o = node.nodeValue;
    var v = (GF.lang === 'th') ? node.__o : tr(node.__o);
    node.__t = v;
    if (node.nodeValue !== v) node.nodeValue = v;
  }
  function obsText(node){                          // observer: external set vs our own write
    if (node.nodeValue === node.__t) return;       // our own write — ignore
    node.__o = node.nodeValue;                     // external set → new source
    applyText(node);
  }
  function applyPh(el){
    if (!el.getAttribute) return;
    if (el.__op === undefined) { var c0 = el.getAttribute('placeholder'); if (c0 == null) return; el.__op = c0; }
    var v = (GF.lang === 'th') ? el.__op : tr(el.__op);
    if (el.getAttribute('placeholder') !== v) el.setAttribute('placeholder', v);
  }
  function walk(node, fn){
    if (!node) return;
    if (node.nodeType === 3) { fn(node); return; }
    if (node.nodeType === 1) {
      var t = node.tagName;
      if (t === 'SCRIPT' || t === 'STYLE') return;
      if (node.hasAttribute && node.hasAttribute('placeholder')) applyPh(node);
      if (t === 'TEXTAREA') return;                // don't translate user input
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c, fn);
    }
  }

  var obs;
  function start(){
    walk(document.body, applyText);
    obs = new MutationObserver(function(muts){
      for (var i=0;i<muts.length;i++){
        var mu = muts[i];
        if (mu.type === 'characterData') obsText(mu.target);
        else if (mu.addedNodes) for (var j=0;j<mu.addedNodes.length;j++) walk(mu.addedNodes[j], applyText);
      }
    });
    obs.observe(document.body, { childList:true, subtree:true, characterData:true });
    injectSwitch();
  }

  GF.setLang = function(l){
    GF.lang = (l === 'th') ? 'th' : 'en';
    try { localStorage.setItem('gf_lang', GF.lang); } catch(e){}
    document.documentElement.setAttribute('lang', GF.lang);
    walk(document.body, applyText);                // re-render everything from stored originals
    var b = document.getElementById('gf-lang-btn'); if (b) b.textContent = GF.lang === 'th' ? 'EN' : 'ไทย';
  };

  function injectSwitch(){
    if (document.getElementById('gf-lang-btn')) return;
    var b = document.createElement('button');
    b.id = 'gf-lang-btn'; b.type = 'button';
    b.textContent = GF.lang === 'th' ? 'EN' : 'ไทย';
    b.setAttribute('aria-label', 'Switch language');
    // Sit inside the header next to the other controls. As a fixed-position
    // overlay this landed on top of the theme button, so the two rendered as
    // one unreadable blob in the top-right corner.
    var host = document.querySelector('.hdr-right');
    if (host) {
      b.className = 'icon-btn';
      b.style.cssText = 'width:auto;padding:0 10px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer';
      b.onclick = function(){ GF.setLang(GF.lang === 'th' ? 'en' : 'th'); };
      host.insertBefore(b, host.firstChild);
      return;
    }
    // Pages we don't own the header of (the served upload/gallery pages).
    b.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top) + 8px);right:10px;z-index:99999;'
      + 'background:rgba(0,0,0,.45);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:100px;'
      + 'padding:6px 12px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer';
    b.onclick = function(){ GF.setLang(GF.lang === 'th' ? 'en' : 'th'); };
    document.body.appendChild(b);
  }

  GF.lang = detect();
  buildRe();
  document.documentElement.setAttribute('lang', GF.lang);
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
