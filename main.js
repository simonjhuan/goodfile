const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow () {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // โหลดไฟล์เว็บจากโฟลเดอร์ www (มาตรฐานของ Capacitor)
  // ถ้าไฟล์ index.html ของคุณอยู่โฟลเดอร์อื่น ให้แก้ path ตรงนี้
  win.loadFile('www/index.html'); 
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});