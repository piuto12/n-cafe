// N Cafe Operator Scanner Controller

const ScannerState = {
  token: null,
  html5QrCode: null,
  pinBuffer: "",

  async init() {
    this.token = localStorage.getItem('operator_token');
    if (!this.token) {
      this.showLoginGate();
      return;
    }

    const verified = await this.verifySession();
    if (!verified) {
      this.logout();
      return;
    }

    await this.fetchSettings();
    this.hideLoginGate();
    this.setupEventListeners();
    this.initScannerView();
  },

  showLoginGate() {
    document.getElementById('operator-login-gate').classList.add('active');
    document.getElementById('operator-scanner-container').style.display = 'none';
    this.resetPinDisplay();
  },

  hideLoginGate() {
    document.getElementById('operator-login-gate').classList.remove('active');
    document.getElementById('operator-scanner-container').style.display = 'block';
  },

  async verifySession() {
    try {
      const res = await fetch('/api/bookings', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      return res.ok;
    } catch (e) {
      console.error("Session verification failed", e);
      return false;
    }
  },

  async fetchSettings() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const settings = await res.json();
        this.ticketExpiryHours = settings.ticketExpiryHours || 5;
      } else {
        this.ticketExpiryHours = 5;
      }
    } catch (e) {
      this.ticketExpiryHours = 5;
    }
  },

  logout() {
    this.stopScannerCamera();
    localStorage.removeItem('operator_token');
    this.token = null;
    this.showLoginGate();
  },

  resetPinDisplay() {
    this.pinBuffer = "";
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach(dot => dot.classList.remove('filled'));
  },

  handleKeyPress(key) {
    if (key === 'back') {
      if (this.pinBuffer.length > 0) {
        this.pinBuffer = this.pinBuffer.slice(0, -1);
      }
    } else {
      if (this.pinBuffer.length < 4) {
        this.pinBuffer += key;
      }
    }

    // Update dots visual
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, idx) => {
      if (idx < this.pinBuffer.length) {
        dot.classList.add('filled');
      } else {
        dot.classList.remove('filled');
      }
    });

    if (this.pinBuffer.length === 4) {
      // Automatically submit the PIN
      this.submitPIN(this.pinBuffer);
    }
  },

  async submitPIN(pin) {
    try {
      const res = await fetch('/api/auth/login-operator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });

      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('operator_token', data.token);
        this.init();
      } else {
        const errData = await res.json();
        alert(errData.error || "Incorrect PIN");
        this.resetPinDisplay();
      }
    } catch (e) {
      console.error(e);
      alert("Failed to connect to server.");
      this.resetPinDisplay();
    }
  },

  setupEventListeners() {
    // Logout button
    document.getElementById('btn-operator-logout').addEventListener('click', () => {
      this.logout();
      window.location.href = '/';
    });

    // Manual code entry form
    document.getElementById('scanner-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = document.getElementById('barcode-scan-input').value.trim();
      if (code) {
        this.triggerScan(code);
      } else {
        alert("Please enter a barcode.");
      }
    });

    // Receipt Popups Actions
    document.getElementById('btn-receipt-cancel').addEventListener('click', () => this.closeReceiptPopup());
  },

  initScannerView() {
    document.getElementById('barcode-scan-input').value = '';
    this.stopScannerCamera().then(() => {
      this.startScannerCamera();
    });
  },

  async startScannerCamera() {
    const barcodeReader = document.getElementById('barcode-reader');
    if (!barcodeReader) return;

    try {
      await loadExternalScript('https://unpkg.com/html5-qrcode');
      if (typeof Html5Qrcode === 'undefined') {
        throw new Error('HTML5 QR Code scanner script loaded without initializing.');
      }
      this.html5QrCode = new Html5Qrcode("barcode-reader");
      const config = {
        fps: 15,
        qrbox: { width: 320, height: 140 },
        formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128]
      };

      Html5Qrcode.getCameras().then(devices => {
        if (devices && devices.length > 0) {
          // Look for back/rear facing cameras for mobile
          let cameraId = devices[0].id;
          const backCam = devices.find(d => {
            const lbl = d.label.toLowerCase();
            return lbl.includes('back') || lbl.includes('rear') || lbl.includes('environment');
          });
          if (backCam) {
            cameraId = backCam.id;
          }

          this.html5QrCode.start(
            cameraId,
            config,
            (decodedText) => {
              console.log("Webcam scanned text:", decodedText);
              document.getElementById('barcode-scan-input').value = decodedText;
              this.triggerScan(decodedText);
            },
            () => {} // safe frame warnings ignore
          ).catch(err => {
            console.warn("Camera start failed with ID, falling back to facingMode:", err);
            this.startScannerWithFacingMode(config, barcodeReader);
          });
        } else {
          this.startScannerWithFacingMode(config, barcodeReader);
        }
      }).catch(err => {
        console.warn("Failed to get devices, falling back to facingMode:", err);
        this.startScannerWithFacingMode(config, barcodeReader);
      });
    } catch (e) {
      console.error("Scanner startup failed:", e);
    }
  },

  startScannerWithFacingMode(config, barcodeReader) {
    if (!this.html5QrCode) return;
    
    this.html5QrCode.start(
      { facingMode: "user" },
      config,
      (decodedText) => {
        console.log("Webcam scanned text (fallback):", decodedText);
        document.getElementById('barcode-scan-input').value = decodedText;
        this.triggerScan(decodedText);
      },
      () => {}
    ).catch(err => {
      console.warn("Camera start failed in fallback mode:", err);
      barcodeReader.innerHTML = `
        <div style="padding: 2rem; font-size: 0.85rem; color: var(--text-muted); text-align: center;">
          <i class="fas fa-camera-slash" style="font-size: 1.8rem; margin-bottom: 0.5rem; color: var(--danger);"></i>
          <p>Live barcode webcam reader unavailable.</p>
          <p style="font-size: 0.75rem; margin-top: 0.25rem;">Use manual entry fallback input.</p>
        </div>
      `;
    });
  },

  async stopScannerCamera() {
    if (this.html5QrCode && this.html5QrCode.isScanning) {
      try {
        await this.html5QrCode.stop();
        this.html5QrCode.clear();
      } catch (err) {
        console.error("Failed to stop scanner:", err);
      }
    }
    this.html5QrCode = null;
  },

  async triggerScan(code) {
    const scannerPrompt = document.getElementById('scanner-prompt-text');
    scannerPrompt.innerText = 'Verifying ticket barcode...';
    
    // Stop camera immediately to prevent duplicate scans
    await this.stopScannerCamera();

    const feedbackSuccess = document.getElementById('scan-feedback-success');
    const feedbackError = document.getElementById('scan-feedback-error');
    const feedbackWarning = document.getElementById('scan-feedback-warning');

    feedbackSuccess.style.display = 'none';
    feedbackError.style.display = 'none';
    feedbackWarning.style.display = 'none';

    // Auto-decode offline ticket format if it's NC-DATA:...
    let bookingPayload = { id: code.trim() };
    if (code.startsWith("NC-DATA:")) {
      const decoded = decodeBookingFromBarcodeText(code);
      if (decoded) {
        // If it's a valid offline format, check if we need to sync it to the server first
        try {
          await fetch('/api/bookings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: decoded.id,
              customerName: decoded.customerName,
              customerPhone: decoded.customerPhone,
              passkey: decoded.passkey,
              items: decoded.items,
              totalAmount: decoded.totalAmount,
              paymentMethod: decoded.paymentMethod,
              lockId: null
            })
          });
          bookingPayload.id = decoded.id;
        } catch (e) {
          console.warn("Offline ticket insert failed/already exists:", e);
          bookingPayload.id = decoded.id;
        }
      }
    }

    try {
      const res = await fetch('/api/bookings/redeem', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify(bookingPayload)
      });

      if (res.status === 200 || res.status === 201) {
        const data = await res.json();
        this.openReceiptPopup(data.booking);
        this.printBill(data.booking);
        
        feedbackSuccess.style.display = 'flex';
        scannerPrompt.innerText = 'Order redeemed successfully';
      } else if (res.status === 409) {
        // Already redeemed
        const errData = await res.json();
        document.getElementById('warning-redeemed-time').innerText = errData.redeemedTime 
          ? new Date(errData.redeemedTime).toLocaleString() 
          : 'Already Redeemed';
        feedbackWarning.style.display = 'flex';
        
        setTimeout(() => {
          feedbackWarning.style.display = 'none';
          scannerPrompt.innerText = 'Align barcode inside screen viewport';
          this.startScannerCamera();
        }, 4000);
      } else if (res.status === 410) {
        const errData = await res.json().catch(() => ({}));
        const isCancelled = errData.status === 'cancelled';
        document.querySelector('#scan-feedback-error .scan-feedback-title').innerText = isCancelled ? 'TICKET CANCELLED' : 'TICKET EXPIRED';
        document.querySelector('#scan-feedback-error .scan-feedback-desc').innerText = isCancelled
          ? 'This ticket was cancelled by a cafe administrator.'
          : `Ticket expired past the ${this.ticketExpiryHours || 5}-hour limit.`;
        feedbackError.style.display = 'flex';
        
        setTimeout(() => {
          feedbackError.style.display = 'none';
          scannerPrompt.innerText = 'Align barcode inside screen viewport';
          this.startScannerCamera();
        }, 3000);
      } else {
        // Not found or other error
        const isUpiLink = code.startsWith("upi://pay") || code.includes("upi://pay");
        if (isUpiLink) {
          document.querySelector('#scan-feedback-error .scan-feedback-title').innerText = 'PAYMENT QR DETECTED';
          document.querySelector('#scan-feedback-error .scan-feedback-desc').innerText = 'Simulate UPI Payment Success on mobile device to generate a ticket barcode first.';
        } else {
          document.querySelector('#scan-feedback-error .scan-feedback-title').innerText = 'INVALID BARCODE';
          document.querySelector('#scan-feedback-error .scan-feedback-desc').innerText = 'Ticket ID not found in database.';
        }
        feedbackError.style.display = 'flex';

        setTimeout(() => {
          feedbackError.style.display = 'none';
          scannerPrompt.innerText = 'Align barcode inside screen viewport';
          this.startScannerCamera();
        }, isUpiLink ? 6000 : 3000);
      }
    } catch (err) {
      console.error(err);
      alert("Network or verification server error.");
      scannerPrompt.innerText = 'Align barcode inside screen viewport';
      this.startScannerCamera();
    }
  },

  openReceiptPopup(booking) {
    const container = document.getElementById('receipt-popup-container');
    container.classList.add('active');

    document.getElementById('receipt-id').innerText = booking.id;
    document.getElementById('receipt-cust-name').innerText = booking.customerName;
    document.getElementById('receipt-cust-phone').innerText = booking.customerPhone;
    document.getElementById('receipt-time').innerText = new Date(booking.bookingTime).toLocaleString();

    const list = document.getElementById('receipt-items-list');
    list.innerHTML = '';
    booking.items.forEach(i => {
      const div = document.createElement('div');
      div.className = 'receipt-popup-item';
      div.innerHTML = `
        <span>${i.name} <span style="color: #6b7280; font-weight: normal; font-size:0.8rem;">x${i.quantity}</span></span>
        <span>₹${i.price * i.quantity}</span>
      `;
      list.appendChild(div);
    });

    const tax = 0;
    const sub = booking.totalAmount;
    document.getElementById('receipt-subtotal').innerText = `₹${sub}`;
    document.getElementById('receipt-tax').innerText = `₹${tax}`;
    document.getElementById('receipt-total').innerText = `₹${booking.totalAmount}`;

    // Bind popup receipt download action
    const dlBtn = document.getElementById('btn-receipt-download');
    if (dlBtn) {
      dlBtn.onclick = () => {
        downloadReceipt(booking);
      };
    }

    // Automatically download receipt and close popup on Confirm click
    const confirmBtn = document.getElementById('btn-receipt-confirm');
    if (confirmBtn) {
      confirmBtn.onclick = () => {
        downloadReceipt(booking);
        this.closeReceiptPopup();
      };
    }
  },

  printBill(booking) {
    document.body.classList.add('printing-receipt');
    this.stopScannerCamera();
    window.setTimeout(() => window.print(), 50);
    window.onafterprint = () => {
      document.body.classList.remove('printing-receipt');
      document.getElementById('receipt-popup-container').classList.remove('active');
      document.getElementById('scan-feedback-success').style.display = 'none';
      document.getElementById('scanner-prompt-text').innerText = 'Align barcode inside screen viewport';
      this.initScannerView();
    };
  },

  closeReceiptPopup() {
    document.getElementById('receipt-popup-container').classList.remove('active');
    
    const feedbackSuccess = document.getElementById('scan-feedback-success');
    feedbackSuccess.style.display = 'none';

    const scannerPrompt = document.getElementById('scanner-prompt-text');
    scannerPrompt.innerText = 'Align barcode inside screen viewport';
    
    this.initScannerView();
  }
};

// Decode booking object from barcode text.
function decodeBookingFromBarcodeText(barcodeText) {
  if (!barcodeText || !barcodeText.startsWith("NC-DATA:")) return null;
  try {
    const base64 = barcodeText.substring(8);
    const jsonStr = decodeURIComponent(escape(atob(base64)));
    const data = JSON.parse(jsonStr);
    return {
      id: data.id,
      customerName: data.cName,
      customerPhone: data.cPhone,
      passkey: data.pk,
      items: data.items.map(i => ({
        foodItemId: i.fid,
        name: i.name,
        quantity: i.qty,
        price: i.price
      })),
      totalAmount: data.total,
      paymentMethod: data.pMethod,
      paymentStatus: data.pStatus,
      bookingTime: data.bTime,
      expiryTime: data.eTime,
      status: data.status,
      redeemedTime: null
    };
  } catch (e) {
    console.error("Failed to decode booking barcode text:", e);
    return null;
  }

  function escapePrintText(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Download receipt utility
function downloadReceipt(booking) {
  if (!booking) return;
  
  const itemsText = booking.items.map(i => `${i.name.padEnd(25)} x${i.quantity.toString().padEnd(3)} - ₹${i.price * i.quantity}`).join('\n');
  const tax = 0;
  const sub = booking.totalAmount;
  
  const textReceiptContent = `
==================================================
                 N   C A F E
==================================================
Invoice Token:  ${booking.id}
Customer Name:  ${booking.customerName}
Phone Number:   ${booking.customerPhone}
Placed Date:    ${new Date(booking.bookingTime).toLocaleString()}
Payment Style:  ${booking.paymentMethod}
Order Status:   ${booking.status.toUpperCase()}
--------------------------------------------------
Delights Particulars:
${itemsText}
--------------------------------------------------
Subtotal:       ₹${sub}
Total Paid:     ₹${booking.totalAmount}
==================================================
        Thank you for ordering at N Cafe!
==================================================
`;

  const blob = new Blob([textReceiptContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `n_cafe_receipt_${booking.id}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Wire Operator dot keypad triggers on page load
document.addEventListener('DOMContentLoaded', () => {
  const keypad = document.getElementById('operator-pin-keypad');
  if (keypad) {
    keypad.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const key = btn.dataset.key;
      if (key) {
        ScannerState.handleKeyPress(key);
      }
    });
  }

  const exitBtn = document.getElementById('btn-operator-exit');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      window.location.href = '/';
    });
  }

  // Initialize operator gate
  ScannerState.init();
});
