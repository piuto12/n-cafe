// N Cafe Admin Dashboard Controller

const AdminState = {
  token: null,
  foodItems: [],
  ingredients: [],
  transactions: [],
  bookings: [],
  billStatusFilter: 'all',
  selectedBillIds: new Set(),
  pollerInterval: null,
  pollInProgress: false,
  lastTransactionPollAt: 0,
  posCart: [],
  posBillingData: null,
  accountDetails: {
    name: 'N Cafe Hills Kitchen Services',
    bank: 'State Bank of India',
    accNo: '39485710293',
    ifsc: 'SBIN0008472',
    upiId: 'ncafe.canteen@okaxis',
    logoBackgroundColor: '#1b4d3e'
  },

  async init() {
    this.token = localStorage.getItem('admin_token');
    if (!this.token) {
      this.showLoginGate();
      return;
    }

    const verified = await this.verifySession();
    if (!verified) {
      this.logout();
      return;
    }

    this.hideLoginGate();
    this.setupEventListeners();
    await this.loadAllData();
    this.startAutoPoller();
  },

  showLoginGate() {
    document.getElementById('admin-login-gate').classList.add('active');
    document.getElementById('admin-dashboard-container').style.display = 'none';
  },

  hideLoginGate() {
    document.getElementById('admin-login-gate').classList.remove('active');
    document.getElementById('admin-dashboard-container').style.display = 'block';
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

  logout() {
    localStorage.removeItem('admin_token');
    this.token = null;
    this.showLoginGate();
    if (this.pollerInterval) {
      clearInterval(this.pollerInterval);
    }
  },

  async fetchWithAuth(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${this.token}`;
    if (options.body && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
    }
    
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
      alert("Session expired. Please log in again.");
      this.logout();
      throw new Error("Unauthorized");
    }
    return res;
  },

  async loadAllData() {
    try {
      await Promise.all([
        this.fetchFoodItems(),
        this.fetchIngredients(),
        this.fetchTransactions(),
        this.fetchBookings(),
        this.fetchAccountDetails()
      ]);
      
      this.renderTab(1);
    } catch (e) {
      console.error("Failed to load initial data", e);
    }
  },

  async fetchFoodItems() {
    const res = await this.fetchWithAuth('/api/admin/food-items');
    if (res.ok) {
      this.foodItems = await res.json();
    }
  },

  async fetchIngredients() {
    const res = await this.fetchWithAuth('/api/ingredients');
    if (res.ok) {
      this.ingredients = await res.json();
    }
  },

  async fetchTransactions() {
    const res = await this.fetchWithAuth('/api/ledger');
    if (res.ok) {
      this.transactions = await res.json();
    }
  },

  async fetchBookings() {
    const res = await this.fetchWithAuth('/api/bookings');
    if (res.ok) {
      this.bookings = await res.json();
    }
  },

  async fetchAccountDetails() {
    const res = await fetch('/api/settings');
    if (res.ok) {
      this.accountDetails = await res.json();
      const logoInput = document.getElementById('branding-logo-input');
      const bannerInput = document.getElementById('branding-banner-input');
      if (logoInput) logoInput.value = this.accountDetails.logoImage || '';
      if (bannerInput) bannerInput.value = this.accountDetails.heroBannerImage || '';
      const logoBackgroundColor = document.getElementById('branding-logo-background-color');
      if (logoBackgroundColor) logoBackgroundColor.value = this.accountDetails.logoBackgroundColor || '#1b4d3e';
      this.applyBranding();
    }
  },

  applyBranding() {
    const logoPath = this.accountDetails.logoImage || '';
    const bannerPath = this.accountDetails.heroBannerImage || '';
    const logoSelectors = [
      ['admin-login-logo-image', 'admin-login-logo-fallback'],
      ['admin-logo-image', 'admin-logo-fallback']
    ];

    logoSelectors.forEach(([imageId, fallbackId]) => {
      const image = document.getElementById(imageId);
      const fallback = document.getElementById(fallbackId);
      if (!image || !fallback) return;
      if (logoPath) {
        image.src = `/${logoPath}`;
        image.style.display = 'block';
        fallback.style.display = 'none';
      } else {
        image.removeAttribute('src');
        image.style.display = 'none';
        fallback.style.display = 'inline';
      }
      image.parentElement.style.background = this.accountDetails.logoBackgroundColor || '#1b4d3e';
    });

    const logoPreview = document.getElementById('branding-logo-preview');
    if (logoPreview) {
      logoPreview.src = logoPath ? `/${logoPath}` : '';
      logoPreview.style.display = logoPath ? 'block' : 'none';
    }
    const bannerPreview = document.getElementById('branding-banner-preview');
    if (bannerPreview) {
      bannerPreview.style.backgroundImage = bannerPath ? `url("/${bannerPath}")` : 'none';
      bannerPreview.style.display = bannerPath ? 'block' : 'none';
    }
  },

  startAutoPoller() {
    if (this.pollerInterval) clearInterval(this.pollerInterval);
    this.pollerInterval = setInterval(async () => {
      if (!this.token || this.pollInProgress) return;
      this.pollInProgress = true;
      try {
        await this.fetchBookings();
        if (Date.now() - this.lastTransactionPollAt >= 30000) {
          await this.fetchTransactions();
          this.lastTransactionPollAt = Date.now();
        }

        const activeTab = document.querySelector('.admin-tab-content.active');
        if (!activeTab) return;
        if (activeTab.id === 'admin-tab-1') {
          this.updateDashboardMetricsOnly();
        } else if (activeTab.id === 'admin-tab-2') {
          this.updateSalesReportTable();
        } else if (activeTab.id === 'admin-tab-6') {
          this.updateHistoryTableOnly();
        } else if (activeTab.id === 'admin-tab-7') {
          this.updateBillsTableOnly();
        }
      } catch (e) {
        console.warn("Auto-poller failed:", e);
      } finally {
        this.pollInProgress = false;
      }
    }, 10000);
  },

  updateDashboardMetricsOnly() {
    const redeemed = this.bookings.filter(b => b.status === 'redeemed');
    const sales = redeemed.reduce((sum, b) => sum + b.totalAmount, 0);
    const expenses = this.transactions.filter(t => t.type === 'purchase' || t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
    const profit = sales - expenses;

    const salesVal = document.getElementById('tab1-sales-val');
    const expensesVal = document.getElementById('tab1-expenses-val');
    const profitVal = document.getElementById('tab1-profit-val');

    if (salesVal) salesVal.innerText = `₹${sales}`;
    if (expensesVal) expensesVal.innerText = `₹${expenses}`;
    if (profitVal) {
      profitVal.innerText = `₹${profit}`;
      profitVal.className = 'admin-card-val ' + (profit >= 0 ? 'income' : 'expense');
    }

    // Update count metrics
    const totalBilledCount = this.bookings.length;
    const scannedCount = this.bookings.filter(b => b.status === 'redeemed').length;
    const pendingCount = this.bookings.filter(b => b.status === 'pending').length;

    const totalBilledEl = document.getElementById('tab1-total-billed-count');
    const scannedEl = document.getElementById('tab1-scanned-count');
    const pendingEl = document.getElementById('tab1-pending-count');

    if (totalBilledEl) totalBilledEl.innerText = totalBilledCount;
    if (scannedEl) scannedEl.innerText = scannedCount;
    if (pendingEl) pendingEl.innerText = pendingCount;

    // Update stock alerts
    const warningsList = document.getElementById('dashboard-stock-alerts-new');
    if (warningsList) {
      warningsList.innerHTML = '';
      let hasWarnings = false;
      this.foodItems.forEach(f => {
        if (f.stock <= 5) {
          hasWarnings = true;
          const box = document.createElement('div');
          box.className = 'alert-box';
          box.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <div>
              <strong>Stock Low: ${f.name}</strong><br>
              <span style="font-size:0.75rem;">Only ${f.stock} portions left in canteen kitchen.</span>
            </div>
          `;
          warningsList.appendChild(box);
        }
      });
      if (!hasWarnings) {
        warningsList.innerHTML = `<div style="text-align:center; color: var(--text-muted); font-size:0.8rem; padding:1rem;">All food items are well stocked today.</div>`;
      }
    }
  },

  updateSalesReportTable() {
    const tbody = document.getElementById('tab2-foodbusiness-tbody');
    if (!tbody) return;

    const filterItem = document.getElementById('report-filter-item').value;
    const filterFrom = document.getElementById('report-filter-from').value;
    const filterTo = document.getElementById('report-filter-to').value;
    const filterAmt = parseFloat(document.getElementById('report-filter-amount').value) || 0;
    const fromTimestamp = filterFrom ? new Date(`${filterFrom}T00:00:00`).getTime() : null;
    const toTimestamp = filterTo ? new Date(`${filterTo}T23:59:59.999`).getTime() : null;

    let filtered = [...this.bookings];

    if (filterItem !== 'All') {
      filtered = filtered.filter(b => b.items.some(i => i.foodItemId === filterItem));
    }
    if (fromTimestamp !== null) {
      filtered = filtered.filter(b => new Date(b.bookingTime).getTime() >= fromTimestamp);
    }
    if (toTimestamp !== null) {
      filtered = filtered.filter(b => new Date(b.bookingTime).getTime() <= toTimestamp);
    }
    if (filterAmt > 0) {
      filtered = filtered.filter(b => b.totalAmount >= filterAmt);
    }

    tbody.innerHTML = '';
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No sales record matches filters.</td></tr>`;
      return;
    }

    filtered.forEach(b => {
      const tr = document.createElement('tr');
      const timeStr = new Date(b.bookingTime).toLocaleString();
      const itemsList = b.items.map(i => `${i.name} (${i.quantity})`).join(', ');
      const statusBadge = this.getBookingStatusBadge(this.getBookingDisplayStatus(b));

      tr.innerHTML = `
        <td>
          <strong>${b.customerName}</strong><br>
          <span style="font-size:0.75rem; color:var(--text-muted);">${b.customerPhone}</span>
        </td>
        <td style="font-size:0.8rem;">${timeStr}</td>
        <td style="font-size:0.8rem; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${itemsList}">${itemsList}</td>
        <td><strong>₹${b.totalAmount}</strong></td>
        <td>${statusBadge}</td>
      `;
      tbody.appendChild(tr);
    });
  },

  setupEventListeners() {
    // Logout button
    document.getElementById('btn-admin-logout').addEventListener('click', () => {
      this.logout();
      window.location.href = '/';
    });

    // Admin Tab Navigation Buttons
    const tabs = [1, 2, 3, 4, 5, 6, 7];
    tabs.forEach(tNum => {
      const btn = document.getElementById(`btn-admin-tab-${tNum}`);
      if (btn) {
        btn.addEventListener('click', () => this.renderTab(tNum));
      }
    });

    const billsStatusFilter = document.getElementById('bills-status-filter');
    if (billsStatusFilter) {
      billsStatusFilter.addEventListener('change', () => {
        this.billStatusFilter = billsStatusFilter.value;
        this.selectedBillIds.clear();
        this.updateBillsTableOnly();
      });
    }

    const billsTable = document.getElementById('bills-tbody');
    if (billsTable) {
      billsTable.addEventListener('change', (event) => {
        const checkbox = event.target.closest('input[data-booking-select]');
        if (!checkbox) return;
        if (checkbox.checked) this.selectedBillIds.add(checkbox.dataset.bookingId);
        else this.selectedBillIds.delete(checkbox.dataset.bookingId);
        this.updateBillsSelectionControls();
      });

      billsTable.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-booking-action]');
        if (!button) return;

        const bookingId = button.dataset.bookingId;
        const isCancel = button.dataset.bookingAction === 'cancel';
        const confirmation = isCancel
          ? 'Cancel this pending ticket? This invalidates the ticket only; it does not issue a refund or restore stock.'
          : 'Permanently delete this bill record? Its accounting ledger entry will be retained.';
        if (!window.confirm(confirmation)) return;

        button.disabled = true;
        try {
          const endpoint = isCancel
            ? `/api/bookings/${encodeURIComponent(bookingId)}/cancel`
            : `/api/bookings/${encodeURIComponent(bookingId)}`;
          const res = await this.fetchWithAuth(endpoint, { method: isCancel ? 'POST' : 'DELETE' });
          const result = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(result.error || 'The bill action failed.');

          this.selectedBillIds.delete(bookingId);
          await this.fetchBookings();
          this.updateBillsTableOnly();
          this.updateDashboardMetricsOnly();
          this.updateSalesReportTable();
          this.updateHistoryTableOnly();
        } catch (error) {
          if (error.message !== 'Unauthorized') {
            alert(`Could not ${isCancel ? 'cancel' : 'delete'} bill: ${error.message}`);
          }
          button.disabled = false;
        }
      });
    }

    const selectVisibleBills = document.getElementById('bills-select-visible');
    if (selectVisibleBills) {
      selectVisibleBills.addEventListener('change', () => {
        document.querySelectorAll('#bills-tbody input[data-booking-select]').forEach(checkbox => {
          checkbox.checked = selectVisibleBills.checked;
          if (checkbox.checked) this.selectedBillIds.add(checkbox.dataset.bookingId);
          else this.selectedBillIds.delete(checkbox.dataset.bookingId);
        });
        this.updateBillsSelectionControls();
      });
    }

    const cancelSelectedBills = document.getElementById('btn-cancel-selected-bills');
    if (cancelSelectedBills) {
      cancelSelectedBills.addEventListener('click', () => this.runBulkBillAction('cancel'));
    }
    const deleteSelectedBills = document.getElementById('btn-delete-selected-bills');
    if (deleteSelectedBills) {
      deleteSelectedBills.addEventListener('click', () => this.runBulkBillAction('delete'));
    }

    // POS Clear Cart button
    const posClearBtn = document.getElementById('btn-pos-clear-cart');
    if (posClearBtn) {
      posClearBtn.addEventListener('click', () => {
        this.posCart = [];
        this.renderPOSCart();
        const form = document.getElementById('pos-billing-form');
        if (form) form.reset();
      });
    }

    // POS Billing Form Submit - Intercept to show Payment selector modal
    document.getElementById('pos-billing-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.posCart.length === 0) return;

      const name = document.getElementById('pos-cust-name').value.trim() || 'Walk-in Guest';
      const phone = document.getElementById('pos-cust-phone').value.trim() || 'N/A';

      const bookingId = 'NC-' + Math.floor(100000 + Math.random() * 900000).toString();
      const grandTotal = this.posCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const tax = 0;
      const totalAmount = grandTotal;

      const items = this.posCart.map(item => ({
        foodItemId: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.price
      }));

      // Store billing data for modal selection callback
      this.posBillingData = {
        id: bookingId,
        customerName: name,
        customerPhone: phone,
        passkey: '0000',
        items,
        totalAmount,
        lockId: null
      };

      // Populate modal particulars and show it
      document.getElementById('pos-modal-amount').innerText = `₹${totalAmount}`;
      document.getElementById('pos-payment-selector').style.display = 'block';
      document.getElementById('pos-payment-upi-screen').style.display = 'none';

      const modal = document.getElementById('pos-payment-modal');
      modal.style.display = 'flex';
      modal.classList.add('active');
    });

    // Modal Button - Cash Payment
    document.getElementById('btn-pos-pay-cash').addEventListener('click', () => {
      this.finalizePOSBooking('Cash (Counter)');
    });

    // Modal Button - UPI QR Selector
    document.getElementById('btn-pos-pay-upi').addEventListener('click', async () => {
      if (!this.posBillingData) return;
      
      const payeeName = this.accountDetails.name || 'N Cafe';
      const upiId = this.accountDetails.upiId || 'ncafe.canteen@okaxis';
      const totalAmount = this.posBillingData.totalAmount;

      document.getElementById('pos-modal-payee').innerText = payeeName;
      document.getElementById('pos-modal-vpa').innerText = upiId;

      // Build standard UPI deep-link URI
      const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${totalAmount}&cu=INR&tn=${encodeURIComponent('N-Cafe-POS-Bill')}`;

      // Render UPI QR canvas
      const canvas = document.getElementById('pos-upi-qr-canvas');
      if (canvas) {
        try {
          await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js');
        } catch (error) {
          console.error('Failed to load the UPI QR generator:', error);
          alert('The UPI QR code could not be loaded. Please try again.');
          return;
        }
        new QRious({
          element: canvas,
          value: upiLink,
          size: 200,
          background: '#ffffff',
          foreground: '#1b4d3e'
        });
      }

      // Transition screens
      document.getElementById('pos-payment-selector').style.display = 'none';
      document.getElementById('pos-payment-upi-screen').style.display = 'block';
    });

    // Modal Button - UPI Back Button
    document.getElementById('btn-pos-upi-back').addEventListener('click', () => {
      document.getElementById('pos-payment-upi-screen').style.display = 'none';
      document.getElementById('pos-payment-selector').style.display = 'block';
    });

    // Modal Button - Confirm UPI Payment Received
    document.getElementById('btn-pos-upi-confirm').addEventListener('click', () => {
      this.finalizePOSBooking('UPI QR (Counter)');
    });

    // Modal Button - Cancel Modal
    document.getElementById('btn-pos-payment-cancel').addEventListener('click', () => {
      const modal = document.getElementById('pos-payment-modal');
      modal.style.display = 'none';
      modal.classList.remove('active');
      this.posBillingData = null;
    });

    // Part 2 Form: Add Food Item
    document.getElementById('tab2-add-food-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const form = e.currentTarget;
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton && submitButton.disabled) return;
      const name = document.getElementById('tab2-add-name').value.trim();
      const price = parseFloat(document.getElementById('tab2-add-price').value);
      const offerPriceInput = document.getElementById('tab2-add-offer-price');
      const offerPrice = offerPriceInput && offerPriceInput.value ? parseFloat(offerPriceInput.value) : null;
      const stock = parseInt(document.getElementById('tab2-add-stock').value, 10);
      const category = document.getElementById('tab2-add-category').value;
      const listed = document.getElementById('tab2-add-listed').checked;
      const isveg = document.getElementById('tab2-add-isveg').value;
      const imagePath = document.getElementById('tab2-add-image').value;
      const desc = document.getElementById('tab2-add-desc').value.trim();

      let maxNum = 100;
      this.foodItems.forEach(f => {
        const num = parseInt(f.id.replace('FD-', ''), 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      });
      const newId = 'FD-' + (maxNum + 1).toString();
      const payload = {
        id: newId,
        name,
        price,
        stock,
        category,
        isveg,
        image: imagePath,
        details: desc,
        offerPrice,
        listed
      };

      try {
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.dataset.originalText = submitButton.innerHTML;
          submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
        }
        const res = await this.fetchWithAuth('/api/food-items', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const result = await res.json();
          const addedItem = {
            ...payload,
            id: result.id || newId,
            offerPrice,
            listed: listed && stock > 0
          };
          this.foodItems.push(addedItem);
          form.reset();
          document.getElementById('tab2-add-listed').checked = true;
          this.renderTab2();
        } else {
          const errData = await res.json();
          alert(`Error: ${errData.error}`);
        }
      } catch (err) {
        console.error(err);
        alert("Unable to add the food item. Please try again.");
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.innerHTML = submitButton.dataset.originalText || 'Add Food to Menu';
        }
      }
    });

    // Food Image Upload trigger listener
    const imgUploadInput = document.getElementById('btn-upload-food-image');
    if (imgUploadInput) {
      imgUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
          alert("Image file too large! Please upload an image under 5MB.");
          return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64Data = event.target.result;
          const imageName = file.name;

          try {
            const res = await this.fetchWithAuth('/api/upload-image', {
              method: 'POST',
              body: JSON.stringify({ imageName, base64Data })
            });

            if (res.ok) {
              const data = await res.json();
              const selectEl = document.getElementById('tab2-add-image');
              if (selectEl) {
                let exists = false;
                for (let i = 0; i < selectEl.options.length; i++) {
                  if (selectEl.options[i].value === data.imagePath) {
                    exists = true;
                    break;
                  }
                }
                if (!exists) {
                  const opt = document.createElement('option');
                  opt.value = data.imagePath;
                  opt.innerText = `${file.name} (Uploaded)`;
                  selectEl.appendChild(opt);
                }
                selectEl.value = data.imagePath;
              }
              alert("Image uploaded successfully and selected!");
            } else {
              const errData = await res.json();
              alert(`Image upload failed: ${errData.error}`);
            }
          } catch (err) {
            console.error("Image upload request failed:", err);
            alert("Error connecting to upload server endpoint.");
          }
        };
        reader.readAsDataURL(file);
      });
    }

    const uploadBrandingImage = (inputId, fieldId) => {
      const input = document.getElementById(inputId);
      if (!input) return;
      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          alert('Image file too large! Please upload an image under 5MB.');
          input.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const res = await this.fetchWithAuth('/api/upload-image', {
              method: 'POST',
              body: JSON.stringify({ imageName: file.name, base64Data: event.target.result })
            });
            if (!res.ok) {
              const error = await res.json();
              throw new Error(error.error || 'Image upload failed.');
            }
            const data = await res.json();
            document.getElementById(fieldId).value = data.imagePath;
            if (fieldId === 'branding-logo-input' || fieldId === 'branding-banner-input') {
              if (fieldId === 'branding-logo-input') this.accountDetails.logoImage = data.imagePath;
              if (fieldId === 'branding-banner-input') this.accountDetails.heroBannerImage = data.imagePath;
              this.applyBranding();
            }
          } catch (err) {
            console.error('Branding image upload failed:', err);
            alert(err.message);
          }
        };
        reader.readAsDataURL(file);
      });
    };
    uploadBrandingImage('branding-logo-upload', 'branding-logo-input');
    uploadBrandingImage('branding-banner-upload', 'branding-banner-input');

    // Report filters change
    document.getElementById('report-filter-item').addEventListener('change', () => this.updateSalesReportTable());
    document.getElementById('report-filter-from').addEventListener('change', () => this.updateSalesReportTable());
    document.getElementById('report-filter-to').addEventListener('change', () => this.updateSalesReportTable());
    document.getElementById('report-filter-amount').addEventListener('input', () => this.updateSalesReportTable());

    // Part 3 Form: Log Purchase
    document.getElementById('tab1-purchase-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ingId = document.getElementById('tab1-pur-ing-id').value;
      const qty = parseFloat(document.getElementById('tab1-pur-qty').value);
      const cost = parseFloat(document.getElementById('tab1-pur-cost').value);

      if (!ingId) return alert("Select an ingredient first.");

      const ing = this.ingredients.find(i => i.id === ingId);
      if (!ing) return;

      const newStock = ing.stock + qty;

      try {
        // Update ingredient stock
        const resIng = await this.fetchWithAuth(`/api/ingredients/${ingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: ing.name, stock: newStock, unit: ing.unit })
        });

        if (resIng.ok) {
          // Add ledger transaction
          await this.fetchWithAuth('/api/ledger', {
            method: 'POST',
            body: JSON.stringify({
              type: 'purchase',
              title: `Restocked - ${ing.name}`,
              amount: cost,
              details: `Added ${qty} ${ing.unit}`
            })
          });

          e.target.reset();
          await this.fetchIngredients();
          await this.fetchTransactions();
          this.renderTab(3);
          alert("Purchase log saved successfully!");
        } else {
          alert("Failed to update ingredient stock.");
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Part 3 Form: Log Usage
    document.getElementById('tab1-usage-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const container = document.getElementById('usage-products-container');
      if (!container) return;

      const rows = container.querySelectorAll('.usage-row');
      const usageData = [];
      let duplicateFound = false;
      let missingSelect = false;

      rows.forEach(row => {
        const ingId = row.querySelector('.usage-ing-select').value;
        const qty = parseFloat(row.querySelector('.usage-qty-input').value);

        if (!ingId) {
          missingSelect = true;
          return;
        }

        if (usageData.some(item => item.ingId === ingId)) {
          duplicateFound = true;
          return;
        }

        usageData.push({ ingId, qty });
      });

      if (missingSelect) return alert("Please select a raw material/product for all rows.");
      if (duplicateFound) return alert("Duplicate ingredients selected. Please combine them into one row.");
      if (usageData.length === 0) return;

      // Validate stock levels before making any API updates
      const updates = [];
      for (let item of usageData) {
        const ing = this.ingredients.find(i => i.id === item.ingId);
        if (!ing) return;

        if (ing.stock < item.qty) {
          return alert(`Deficit! Only ${ing.stock} ${ing.unit} available for ${ing.name}.`);
        }

        const newStock = ing.stock - item.qty;
        updates.push({ ing, qty: item.qty, newStock });
      }

      try {
        for (let up of updates) {
          // Update ingredient stock
          const resIng = await this.fetchWithAuth(`/api/ingredients/${up.ing.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: up.ing.name, stock: up.newStock, unit: up.ing.unit })
          });

          if (!resIng.ok) {
            throw new Error(`Failed to update stock for ${up.ing.name}`);
          }

          // Add ledger transaction
          await this.fetchWithAuth('/api/ledger', {
            method: 'POST',
            body: JSON.stringify({
              type: 'expense',
              title: `Used in Kitchen - ${up.ing.name}`,
              amount: 0,
              details: `Used ${up.qty} ${up.ing.unit}`
            })
          });
        }

        // Download the unified usage slip
        downloadUsageSlip(updates);

        // Reset form to single row
        container.innerHTML = '';
        this.addKitchenUsageRow();

        await this.fetchIngredients();
        await this.fetchTransactions();
        this.renderTab(3);
        alert("Kitchen usage logged successfully! Slip downloaded.");
      } catch (err) {
        console.error(err);
        alert("Error logging kitchen usage.");
      }
    });

    // Wire up dynamic usage rows add button
    const btnAddRow = document.getElementById('btn-usage-add-row');
    if (btnAddRow) {
      btnAddRow.addEventListener('click', () => this.addKitchenUsageRow());
    }

    // Part 3 Form: Register New Material
    const addIngForm = document.getElementById('tab1-add-ing-form');
    if (addIngForm) {
      addIngForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('tab1-add-ing-name').value.trim();
        const unit = document.getElementById('tab1-add-ing-unit').value;
        const stock = parseFloat(document.getElementById('tab1-add-ing-stock').value) || 0;

        // Auto-generate ingredient ID
        let maxNum = 100;
        this.ingredients.forEach(i => {
          const num = parseInt(i.id.replace('ING-', ''), 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        });
        const newId = 'ING-' + (maxNum + 1).toString().padStart(3, '0');

        const payload = {
          id: newId,
          name,
          stock,
          unit
        };

        try {
          const res = await this.fetchWithAuth('/api/ingredients', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            e.target.reset();
            await this.fetchIngredients();
            this.renderTab(3);
            alert("New material registered successfully!");
          } else {
            const errData = await res.json();
            alert(`Error: ${errData.error}`);
          }
        } catch (err) {
          console.error(err);
        }
      });
    }

    // Download CSV buttons
    document.getElementById('btn-export-inventory').addEventListener('click', () => this.exportInventoryCSV());
    document.getElementById('btn-export-ledger').addEventListener('click', () => this.exportLedgerCSV());

    const saveAccountSettings = async (successMessage) => {
      const name = document.getElementById('acc-name-input').value.trim() || this.accountDetails.name;
      const upiId = document.getElementById('acc-upi-input').value.trim() || this.accountDetails.upiId;
      const bank = document.getElementById('acc-bank-input').value.trim() || this.accountDetails.bank;
      const accNo = document.getElementById('acc-no-input').value.trim() || this.accountDetails.accNo;
      const ifsc = document.getElementById('acc-ifsc-input').value.trim() || this.accountDetails.ifsc;
      const ticketExpiryHours = parseInt(document.getElementById('acc-expiry-input').value, 10) || this.accountDetails.ticketExpiryHours || 5;
      const logoImage = document.getElementById('branding-logo-input').value.trim();
      const heroBannerImage = document.getElementById('branding-banner-input').value.trim();
      const logoBackgroundColor = document.getElementById('branding-logo-background-color').value;
      const payload = { name, upiId, bank, accNo, ifsc, ticketExpiryHours, logoImage, heroBannerImage, logoBackgroundColor };
      try {
        const res = await this.fetchWithAuth('/api/settings', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          await this.fetchAccountDetails();
          alert(successMessage);
        } else {
          const error = await res.json().catch(() => ({}));
          alert(error.error || "Failed to save settings.");
        }
      } catch (err) {
        console.error(err);
        alert("Failed to save settings.");
      }
    };

    // Account settings Form
    document.getElementById('tab3-account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveAccountSettings("Account profile saved successfully!");
    });

    document.getElementById('btn-save-branding-settings').addEventListener('click', async () => {
      await saveAccountSettings("Branding settings saved successfully!");
    });

    // Credentials toggle and Form
    document.getElementById('btn-toggle-credentials').addEventListener('click', () => {
      const form = document.getElementById('tab4-credentials-form');
      const chevron = document.getElementById('credentials-chevron');
      if (form.style.display === 'none') {
        form.style.display = 'block';
        chevron.style.transform = 'rotate(180deg)';
      } else {
        form.style.display = 'none';
        chevron.style.transform = 'rotate(0deg)';
      }
    });

    document.getElementById('tab4-credentials-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('cred-current-pwd').value;
      const password = document.getElementById('cred-admin-pwd').value.trim();
      const pin = document.getElementById('cred-scanner-pin').value.trim();

      try {
        const res = await this.fetchWithAuth('/api/auth/change-credentials', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, password, pin })
        });
        if (res.ok) {
          e.target.reset();
          document.getElementById('tab4-credentials-form').style.display = 'none';
          document.getElementById('credentials-chevron').style.transform = 'rotate(0deg)';
          alert("Admin credentials and scanner PIN successfully updated!");
        } else {
          const errData = await res.json();
          alert(`Failed to update credentials: ${errData.error}`);
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Razorpay toggle and Form Submit
    const toggleRzpBtn = document.getElementById('btn-toggle-razorpay');
    if (toggleRzpBtn) {
      toggleRzpBtn.addEventListener('click', () => {
        const form = document.getElementById('tab4-razorpay-form');
        const chevron = document.getElementById('razorpay-chevron');
        if (form.style.display === 'none') {
          form.style.display = 'block';
          chevron.style.transform = 'rotate(180deg)';
        } else {
          form.style.display = 'none';
          chevron.style.transform = 'rotate(0deg)';
        }
      });
    }

    const rzpForm = document.getElementById('tab4-razorpay-form');
    if (rzpForm) {
      rzpForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const keyId = document.getElementById('rzp-key-id').value.trim();
        const keySecret = document.getElementById('rzp-key-secret').value.trim();

        try {
          const res = await this.fetchWithAuth('/api/settings/razorpay', {
            method: 'POST',
            body: JSON.stringify({ keyId, keySecret })
          });
          if (res.ok) {
            document.getElementById('rzp-key-secret').value = '';
            document.getElementById('tab4-razorpay-form').style.display = 'none';
            document.getElementById('razorpay-chevron').style.transform = 'rotate(0deg)';
            alert("Razorpay API credentials successfully updated!");
            
            // Reload Tab 4 to prefill values
            this.renderTab(4);
          } else {
            const errData = await res.json();
            alert(`Failed to save credentials: ${errData.error}`);
          }
        } catch (err) {
          console.error(err);
        }
      });
    }

    // Special Offer toggle and Form Submit
    const toggleSoBtn = document.getElementById('btn-toggle-special-offer');
    if (toggleSoBtn) {
      toggleSoBtn.addEventListener('click', () => {
        const form = document.getElementById('tab2-special-offer-form');
        const chevron = document.getElementById('special-offer-chevron');
        if (form.style.display === 'none') {
          form.style.display = 'block';
          chevron.style.transform = 'rotate(180deg)';
        } else {
          form.style.display = 'none';
          chevron.style.transform = 'rotate(0deg)';
        }
      });
    }

    const soForm = document.getElementById('tab2-special-offer-form');
    if (soForm) {
      soForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const active = document.getElementById('so-active').checked;
        const title = document.getElementById('so-title').value.trim();
        const desc = document.getElementById('so-desc').value.trim();
        const price = parseFloat(document.getElementById('so-price').value) || 0;
        const image = document.getElementById('so-image-select').value;

        try {
          const res = await this.fetchWithAuth('/api/special-offer', {
            method: 'POST',
            body: JSON.stringify({ active, title, desc, price, image })
          });
          if (res.ok) {
            document.getElementById('tab2-special-offer-form').style.display = 'none';
            document.getElementById('special-offer-chevron').style.transform = 'rotate(0deg)';
            alert("Special offer settings successfully updated!");
            
            // Reload Tab 2 to prefill values
            this.renderTab(2);
          } else {
            const errData = await res.json();
            alert(`Failed to save special offer settings: ${errData.error}`);
          }
        } catch (err) {
          console.error(err);
        }
      });
    }

    // Stop Special Offer Button Listener
    const btnStopSo = document.getElementById('btn-stop-special-offer');
    if (btnStopSo) {
      btnStopSo.addEventListener('click', async () => {
        const title = document.getElementById('so-title').value.trim() || 'Special Hills Combo';
        const desc = document.getElementById('so-desc').value.trim();
        const price = parseFloat(document.getElementById('so-price').value) || 0;
        const image = document.getElementById('so-image-select').value;

        try {
          const res = await this.fetchWithAuth('/api/special-offer', {
            method: 'POST',
            body: JSON.stringify({ active: false, title, desc, price, image })
          });
          if (res.ok) {
            document.getElementById('so-active').checked = false;
            document.getElementById('tab2-special-offer-form').style.display = 'none';
            document.getElementById('special-offer-chevron').style.transform = 'rotate(0deg)';
            alert("Special offer promotion stopped and deactivated!");
            this.renderTab(2);
          } else {
            alert("Failed to deactivate special offer.");
          }
        } catch (err) {
          console.error(err);
        }
      });
    }

    // Special Offer Image Upload trigger listener
    const soImgUploadInput = document.getElementById('btn-upload-so-image');
    if (soImgUploadInput) {
      soImgUploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
          alert("Image file too large! Please upload an image under 5MB.");
          return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64Data = event.target.result;
          const imageName = file.name;

          try {
            const res = await this.fetchWithAuth('/api/upload-image', {
              method: 'POST',
              body: JSON.stringify({ imageName, base64Data })
            });

            if (res.ok) {
              const data = await res.json();
              const selectEl = document.getElementById('so-image-select');
              if (selectEl) {
                let exists = false;
                for (let i = 0; i < selectEl.options.length; i++) {
                  if (selectEl.options[i].value === data.imagePath) {
                    exists = true;
                    break;
                  }
                }
                if (!exists) {
                  const opt = document.createElement('option');
                  opt.value = data.imagePath;
                  opt.innerText = `${file.name} (Uploaded)`;
                  selectEl.appendChild(opt);
                }
                selectEl.value = data.imagePath;
              }
            } else {
              const errData = await res.json();
              alert(`Error: ${errData.error}`);
            }
          } catch (err) {
            console.error(err);
          }
        };
        reader.readAsDataURL(file);
      });
    }

    // Manual backup JSON
    document.getElementById('btn-backup-db').addEventListener('click', async () => {
      try {
        const res = await this.fetchWithAuth('/api/backup/export');
        if (res.ok) {
          const backupData = await res.json();
          const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `n_cafe_backup_${new Date().toISOString().slice(0,10)}.json`;
          link.click();
        }
      } catch (err) {
        console.error(err);
      }
    });

    // Manual restore JSON
    document.getElementById('restore-db-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const backupObj = JSON.parse(event.target.result);
          const confirmRestore = confirm("Are you sure you want to restore? This will overwrite your current SQLite tables.");
          if (!confirmRestore) return;

          const res = await this.fetchWithAuth('/api/backup/restore', {
            method: 'POST',
            body: JSON.stringify(backupObj)
          });

          if (res.ok) {
            alert("Database snapshot restored successfully!");
            window.location.reload();
          } else {
            const errData = await res.json();
            alert(`Restore failed: ${errData.error}`);
          }
        } catch (err) {
          alert("Invalid JSON file format.");
        }
      };
      reader.readAsText(file);
    });

    // Ledger select all checkbox
    const selectAllCb = document.getElementById('ledger-select-all');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.ledger-row-cb').forEach(cb => {
          cb.checked = checked;
        });
      });
    }

    // Part 6 Unified History listeners
    const histFilter = document.getElementById('history-filter-type');
    if (histFilter) histFilter.addEventListener('change', () => this.updateHistoryTableOnly());
    
    const histSearch = document.getElementById('history-search-input');
    if (histSearch) histSearch.addEventListener('input', () => this.updateHistoryTableOnly());

    const histFromDate = document.getElementById('history-filter-from');
    if (histFromDate) histFromDate.addEventListener('change', () => this.updateHistoryTableOnly());

    const histToDate = document.getElementById('history-filter-to');
    if (histToDate) histToDate.addEventListener('change', () => this.updateHistoryTableOnly());
    
    const histExport = document.getElementById('btn-export-history-csv');
    if (histExport) histExport.addEventListener('click', () => this.exportUnifiedHistoryCSV());

    // Part 6 Sub-tabs navigation
    const btnSubHist = document.getElementById('btn-subtab-history');
    const btnSubSales = document.getElementById('btn-subtab-sales');
    if (btnSubHist && btnSubSales) {
      btnSubHist.addEventListener('click', () => {
        btnSubHist.classList.add('active');
        btnSubHist.style.color = 'var(--text-main)';
        btnSubHist.style.borderBottom = '2px solid var(--accent)';
        
        btnSubSales.classList.remove('active');
        btnSubSales.style.color = 'var(--text-muted)';
        btnSubSales.style.borderBottom = 'none';

        const viewHist = document.getElementById('part6-history-view');
        if (viewHist) viewHist.style.display = 'flex';
        const viewSales = document.getElementById('part6-sales-view');
        if (viewSales) viewSales.style.display = 'none';
      });

      btnSubSales.addEventListener('click', () => {
        btnSubSales.classList.add('active');
        btnSubSales.style.color = 'var(--text-main)';
        btnSubSales.style.borderBottom = '2px solid var(--accent)';
        
        btnSubHist.classList.remove('active');
        btnSubHist.style.color = 'var(--text-muted)';
        btnSubHist.style.borderBottom = 'none';

        const viewHist = document.getElementById('part6-history-view');
        if (viewHist) viewHist.style.display = 'none';
        const viewSales = document.getElementById('part6-sales-view');
        if (viewSales) viewSales.style.display = 'block';
      });
    }
  },

  async finalizePOSBooking(paymentMethod) {
    if (!this.posBillingData) return;
    
    const payload = {
      ...this.posBillingData,
      paymentMethod
    };

    // Close Modal
    const modal = document.getElementById('pos-payment-modal');
    modal.style.display = 'none';
    modal.classList.remove('active');

    try {
      // Post the booking
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        // Immediately redeem it since it's a walk-in billing
        await this.fetchWithAuth('/api/bookings/redeem', {
          method: 'POST',
          body: JSON.stringify({ id: payload.id })
        });

        // Fetch the full redeemed booking info to download the receipt
        const bookingsRes = await this.fetchWithAuth('/api/bookings');
        if (bookingsRes.ok) {
          const allBookings = await bookingsRes.json();
          const matching = allBookings.find(b => b.id === payload.id);
          if (matching) {
            downloadReceipt(matching);
          }
        }

        // Reset cart & form
        this.posCart = [];
        this.renderPOSCart();
        document.getElementById('pos-billing-form').reset();
        
        // Reload
        await this.fetchFoodItems();
        await this.fetchBookings();
        await this.fetchTransactions();
        this.renderTab(5); // Render POS Canteen Counter tab
        
        alert(`POS counter invoice created via ${paymentMethod}! Token: ${payload.id}. Receipt automatically downloaded.`);
      } else {
        const errData = await res.json();
        alert(`Checkout failed: ${errData.error || 'Server error'}`);
      }
    } catch (err) {
      console.error("POS transaction failed:", err);
      alert("Communication error finalizing POS booking.");
    } finally {
      this.posBillingData = null;
    }
  },

  addKitchenUsageRow(ingId = '', qty = '') {
    const container = document.getElementById('usage-products-container');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'usage-row';
    row.style.display = 'flex';
    row.style.gap = '0.5rem';
    row.style.alignItems = 'center';

    let options = '<option value="">-- Select Material --</option>';
    this.ingredients.forEach(i => {
      options += `<option value="${i.id}" ${i.id === ingId ? 'selected' : ''}>${i.name} (Remaining: ${i.stock} ${i.unit})</option>`;
    });

    row.innerHTML = `
      <select class="usage-ing-select" required style="flex: 1.5; padding: 0.5rem; background: var(--bg-dark); border: 1px solid var(--border-dark); color: #fff; border-radius: 8px; font-size: 0.85rem; height: 38px;">
        ${options}
      </select>
      <input type="number" step="0.1" class="usage-qty-input" placeholder="Qty" min="0.1" ${qty ? `value="${qty}"` : ''} required style="flex: 1; padding: 0.5rem; background: var(--bg-dark); border: 1px solid var(--border-dark); color: #fff; border-radius: 8px; font-size: 0.85rem; height: 38px; text-align: center;">
      <button type="button" class="btn-sm btn-remove-usage-row" style="background: rgba(234,67,53,0.1); color: #ea4335; border: 1px solid rgba(234,67,53,0.2); width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; padding: 0; border-radius: 8px; cursor: pointer;">
        <i class="fas fa-trash"></i>
      </button>
    `;

    row.querySelector('.btn-remove-usage-row').addEventListener('click', () => {
      if (container.querySelectorAll('.usage-row').length > 1) {
        row.remove();
      } else {
        alert("At least one product is required.");
      }
    });

    container.appendChild(row);
  },

  updateKitchenUsageSelects() {
    const container = document.getElementById('usage-products-container');
    if (!container) return;

    const selects = container.querySelectorAll('.usage-ing-select');
    selects.forEach(select => {
      const currentVal = select.value;
      select.innerHTML = '<option value="">-- Select Material --</option>';
      this.ingredients.forEach(i => {
        select.innerHTML += `<option value="${i.id}" ${i.id === currentVal ? 'selected' : ''}>${i.name} (Remaining: ${i.stock} ${i.unit})</option>`;
      });
      select.value = currentVal;
    });
  },

  renderTab(tNum) {
    // Toggle active tab buttons
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `btn-admin-tab-${tNum}`);
    });

    // Toggle active tab panes
    document.querySelectorAll('.admin-tab-content').forEach(pane => {
      pane.style.display = pane.id === `admin-tab-${tNum}` ? 'block' : 'none';
      pane.classList.toggle('active', pane.id === `admin-tab-${tNum}`);
    });

    if (tNum === 1) {
      this.renderTab1();
    } else if (tNum === 2) {
      this.renderTab2();
    } else if (tNum === 3) {
      this.renderTab3();
    } else if (tNum === 4) {
      this.renderTab4();
    } else if (tNum === 5) {
      this.renderTab5();
    } else if (tNum === 6) {
      this.renderTab6();
    } else if (tNum === 7) {
      this.updateBillsTableOnly();
    }
  },

  getBookingDisplayStatus(booking) {
    if (booking.status === 'pending' && new Date(booking.expiryTime).getTime() <= Date.now()) {
      return 'expired';
    }
    return booking.status;
  },

  getBookingStatusBadge(status) {
    if (status === 'redeemed') return '<span class="badge badge-success">Printed / Redeemed</span>';
    if (status === 'expired') return '<span class="badge badge-danger">Expired</span>';
    if (status === 'cancelled') return '<span class="badge badge-danger">Cancelled</span>';
    return '<span class="badge badge-warning">Pending</span>';
  },

  updateBillsSelectionControls(visibleBookings = null) {
    const visibleIds = visibleBookings
      ? new Set(visibleBookings.map(booking => booking.id))
      : new Set(Array.from(document.querySelectorAll('#bills-tbody input[data-booking-select]'))
        .map(checkbox => checkbox.dataset.bookingId));
    const selectedVisible = [...this.selectedBillIds].filter(id => visibleIds.has(id));
    const count = document.getElementById('bills-selected-count');
    const cancelButton = document.getElementById('btn-cancel-selected-bills');
    const deleteButton = document.getElementById('btn-delete-selected-bills');
    const selectVisible = document.getElementById('bills-select-visible');
    const pendingCount = selectedVisible.filter(id => {
      const booking = this.bookings.find(item => item.id === id);
      return booking && this.getBookingDisplayStatus(booking) === 'pending';
    }).length;

    if (count) count.textContent = `${this.selectedBillIds.size} bill${this.selectedBillIds.size === 1 ? '' : 's'} selected`;
    if (cancelButton) cancelButton.disabled = pendingCount === 0;
    if (deleteButton) deleteButton.disabled = this.selectedBillIds.size === 0;
    if (selectVisible) {
      selectVisible.checked = visibleIds.size > 0 && [...visibleIds].every(id => this.selectedBillIds.has(id));
      selectVisible.indeterminate = [...visibleIds].some(id => this.selectedBillIds.has(id)) && !selectVisible.checked;
    }
  },

  async runBulkBillAction(action) {
    const selectedBookings = this.bookings.filter(booking =>
      this.selectedBillIds.has(booking.id) &&
      (action !== 'cancel' || this.getBookingDisplayStatus(booking) === 'pending')
    );
    if (selectedBookings.length === 0) return;

    const isCancel = action === 'cancel';
    const confirmation = isCancel
      ? `Cancel ${selectedBookings.length} selected pending bill${selectedBookings.length === 1 ? '' : 's'}? This does not issue refunds or restore stock.`
      : `Permanently delete ${selectedBookings.length} selected bill record${selectedBookings.length === 1 ? '' : 's'}? Their accounting ledger entries will be retained.`;
    if (!window.confirm(confirmation)) return;

    const cancelButton = document.getElementById('btn-cancel-selected-bills');
    const deleteButton = document.getElementById('btn-delete-selected-bills');
    if (cancelButton) cancelButton.disabled = true;
    if (deleteButton) deleteButton.disabled = true;

    const failures = [];
    for (let start = 0; start < selectedBookings.length; start += 5) {
      const batch = selectedBookings.slice(start, start + 5);
      const results = await Promise.all(batch.map(async booking => {
        try {
          const endpoint = isCancel
            ? `/api/bookings/${encodeURIComponent(booking.id)}/cancel`
            : `/api/bookings/${encodeURIComponent(booking.id)}`;
          const response = await this.fetchWithAuth(endpoint, { method: isCancel ? 'POST' : 'DELETE' });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || 'The bill action failed.');
          return { id: booking.id };
        } catch (error) {
          return { id: booking.id, error };
        }
      }));
      results.forEach(result => {
        if (result.error) failures.push(result);
        else this.selectedBillIds.delete(result.id);
      });
      if (!this.token) return;
    }

    try {
      await this.fetchBookings();
      this.updateBillsTableOnly();
      this.updateDashboardMetricsOnly();
      this.updateSalesReportTable();
      this.updateHistoryTableOnly();
      if (failures.length > 0) {
        alert(`${selectedBookings.length - failures.length} bill${selectedBookings.length - failures.length === 1 ? '' : 's'} updated. ${failures.length} failed: ${failures.map(item => `${item.id}: ${item.error.message}`).join('; ')}`);
      }
    } catch (error) {
      alert(`Could not refresh bills after the bulk action: ${error.message}`);
    } finally {
      this.updateBillsSelectionControls();
    }
  },

  updateBillsTableOnly() {
    const tbody = document.getElementById('bills-tbody');
    if (!tbody) return;

    const filter = document.getElementById('bills-status-filter');
    if (filter) filter.value = this.billStatusFilter;
    const bookings = this.bookings.filter(booking => {
      const status = this.getBookingDisplayStatus(booking);
      return this.billStatusFilter === 'all' || status === this.billStatusFilter;
    });
    const visibleIds = new Set(bookings.map(booking => booking.id));
    this.selectedBillIds = new Set([...this.selectedBillIds].filter(id => visibleIds.has(id)));
    tbody.replaceChildren();

    if (bookings.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.textContent = 'No bills found for this status.';
      cell.style.cssText = 'text-align:center; color:var(--text-muted); padding:1rem;';
      row.appendChild(cell);
      tbody.appendChild(row);
      this.updateBillsSelectionControls(bookings);
      return;
    }

    bookings.forEach(booking => {
      const row = document.createElement('tr');
      const customer = document.createElement('td');
      customer.textContent = `${booking.customerName || 'Unknown customer'} (${booking.customerPhone || 'No phone'})`;
      const time = document.createElement('td');
      const bookingDate = new Date(booking.bookingTime);
      time.textContent = Number.isNaN(bookingDate.getTime()) ? '—' : bookingDate.toLocaleString();
      const items = document.createElement('td');
      items.textContent = (booking.items || []).map(item => `${item.name} (${item.quantity})`).join(', ') || '—';
      const amount = document.createElement('td');
      amount.textContent = `₹${booking.totalAmount ?? 0}`;
      const payment = document.createElement('td');
      payment.textContent = `${booking.paymentMethod || '—'} (${booking.paymentStatus || '—'})`;
      const status = document.createElement('td');
      status.innerHTML = this.getBookingStatusBadge(this.getBookingDisplayStatus(booking));
      const actions = document.createElement('td');
      actions.style.cssText = 'display:flex; gap:0.4rem; flex-wrap:wrap;';
      const selection = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.bookingSelect = 'true';
      checkbox.dataset.bookingId = booking.id;
      checkbox.checked = this.selectedBillIds.has(booking.id);
      checkbox.setAttribute('aria-label', `Select bill for ${booking.customerName || 'customer'}`);
      selection.appendChild(checkbox);

      if (this.getBookingDisplayStatus(booking) === 'pending') {
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn-sm btn-sm-danger';
        cancelButton.dataset.bookingAction = 'cancel';
        cancelButton.dataset.bookingId = booking.id;
        cancelButton.textContent = 'Cancel';
        actions.appendChild(cancelButton);
      }

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'btn-sm btn-sm-danger';
      deleteButton.dataset.bookingAction = 'delete';
      deleteButton.dataset.bookingId = booking.id;
      deleteButton.textContent = 'Delete';
      actions.appendChild(deleteButton);

      row.append(selection, customer, time, items, amount, payment, status, actions);
      tbody.appendChild(row);
    });
    this.updateBillsSelectionControls(bookings);
  },

  renderTab1() {
    this.updateDashboardMetricsOnly();
  },

  renderTab5() {
    // Render POS Counter menu catalog
    const catalogDiv = document.getElementById('pos-food-catalog');
    if (catalogDiv) {
      catalogDiv.innerHTML = '';
      if (this.foodItems.length === 0) {
        catalogDiv.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:1rem;">No items listed.</div>`;
      }
      this.foodItems.forEach(f => {
        const card = document.createElement('div');
        card.className = `pos-item-card ${f.stock === 0 ? 'disabled' : ''}`;
        
        const hasOffer = f.offerPrice && f.offerPrice < f.price;
        const priceHTML = hasOffer 
          ? `<span style="text-decoration: line-through; color: var(--text-muted); margin-right: 0.25rem;">₹${f.price}</span><span style="font-weight:700; color:var(--accent);">₹${f.offerPrice}</span>` 
          : `<span style="font-weight:700; color:var(--accent);">₹${f.price}</span>`;

        card.innerHTML = `
          <div class="pos-item-title">${f.name}</div>
          <div class="flex justify-between align-center" style="margin-top: 0.5rem; font-size: 0.75rem;">
            <span>${priceHTML}</span>
            <span style="color:var(--text-muted);">${f.stock > 0 ? f.stock + ' left' : 'OUT'}</span>
          </div>
        `;
        if (f.stock > 0) {
          card.addEventListener('click', () => this.addToPOSCart(f));
        }
        catalogDiv.appendChild(card);
      });
    }

    this.renderPOSCart();
  },

  addToPOSCart(food) {
    const existing = this.posCart.find(i => i.id === food.id);
    if (existing) {
      if (existing.quantity >= food.stock) {
        alert(`Cannot add more. Portions left in canteen: ${food.stock}`);
        return;
      }
      existing.quantity++;
    } else {
      const activePrice = (food.offerPrice && food.offerPrice < food.price) ? food.offerPrice : food.price;
      this.posCart.push({
        id: food.id,
        name: food.name,
        price: activePrice,
        quantity: 1
      });
    }
    this.renderPOSCart();
  },

  updatePOSQty(id, delta) {
    const existing = this.posCart.find(i => i.id === id);
    if (!existing) return;

    const food = this.foodItems.find(f => f.id === id);
    if (!food) return;

    existing.quantity += delta;
    if (existing.quantity <= 0) {
      this.posCart = this.posCart.filter(i => i.id !== id);
    } else if (existing.quantity > food.stock) {
      alert(`Only ${food.stock} portions available.`);
      existing.quantity = food.stock;
    }
    this.renderPOSCart();
  },

  renderPOSCart() {
    const list = document.getElementById('pos-cart-list');
    const subTotalSpan = document.getElementById('pos-subtotal');
    const taxSpan = document.getElementById('pos-tax');
    const totalSpan = document.getElementById('pos-total');
    const submitBtn = document.getElementById('btn-pos-submit');

    if (!list) return;

    list.innerHTML = '';
    if (this.posCart.length === 0) {
      list.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size:0.8rem;">Draft billing receipt is empty.</div>`;
      subTotalSpan.innerText = '₹0';
      taxSpan.innerText = '₹0';
      totalSpan.innerText = '₹0';
      submitBtn.disabled = true;
      return;
    }

    let subtotal = 0;
    this.posCart.forEach(item => {
      const itemTotal = item.price * item.quantity;
      subtotal += itemTotal;

      const row = document.createElement('div');
      row.className = 'pos-cart-item';
      row.innerHTML = `
        <div style="flex-grow: 1;">
          <strong>${item.name}</strong><br>
          <span style="color: var(--text-muted); font-size:0.75rem;">₹${item.price} each</span>
        </div>
        <div class="flex align-center gap-1" style="margin-right: 1rem;">
          <button type="button" class="qty-btn btn-minus" data-id="${item.id}">-</button>
          <span style="font-size:0.85rem; font-weight:bold;">${item.quantity}</span>
          <button type="button" class="qty-btn btn-plus" data-id="${item.id}">+</button>
        </div>
        <div style="font-weight: 600; font-size:0.85rem;">₹${itemTotal}</div>
      `;

      row.querySelector('.btn-minus').addEventListener('click', () => this.updatePOSQty(item.id, -1));
      row.querySelector('.btn-plus').addEventListener('click', () => this.updatePOSQty(item.id, 1));

      list.appendChild(row);
    });

    const tax = 0;
    const total = subtotal;

    subTotalSpan.innerText = `₹${subtotal}`;
    taxSpan.innerText = `₹${tax}`;
    totalSpan.innerText = `₹${total}`;
    submitBtn.disabled = false;
  },

  renderTab2() {
    // Render Menu quantities table
    const tbody = document.getElementById('tab2-menu-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      if (this.foodItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No food items found.</td></tr>`;
      }
      this.foodItems.forEach(f => {
        const tr = document.createElement('tr');
        const imgName = f.image.split('/').pop(); // Extract basename
        const isListed = Boolean(f.listed) && Number(f.stock) > 0;
        tr.innerHTML = `
          <td><img src="assets/${imgName}" style="width:36px; height:36px; border-radius:6px; object-fit:cover;" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22><rect width=%2236%22 height=%2236%22 fill=%22%23222%22/></svg>'"></td>
          <td><strong>${f.name}</strong><br><span style="font-size:0.7rem; color:var(--text-muted);">${f.category} | ${f.isveg}</span></td>
          <td>
            ₹${f.price}
            <div style="display:flex; align-items:center; gap:0.25rem; margin-top:0.25rem;">
              <span style="font-size:0.7rem; color:var(--text-muted);">Offer:</span>
              <input type="number" class="offer-price-inline-edit" data-id="${f.id}" value="${f.offerPrice !== undefined && f.offerPrice !== null ? f.offerPrice : ''}" placeholder="None" style="width:55px; padding:0.15rem 0.25rem; font-size:0.75rem; background:var(--bg-dark); border:1px solid var(--border-dark); color:#fff; border-radius:4px; text-align:center;">
            </div>
          </td>
          <td>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <input type="number" class="stock-inline-edit" data-id="${f.id}" value="${f.stock}" style="width:55px; padding:0.25rem; font-size:0.8rem; background:var(--bg-dark); border:1px solid var(--border-dark); color:#fff; border-radius:4px; text-align:center;">
              <button class="btn-sm btn-save-stock" data-id="${f.id}" style="padding:0.25rem 0.4rem; font-size:0.75rem;"><i class="fas fa-save"></i></button>
              <input type="number" class="stock-add-input" data-id="${f.id}" value="0" min="0" step="1" style="width:55px; padding:0.25rem; font-size:0.8rem; background:var(--bg-dark); border:1px solid var(--border-dark); color:#fff; border-radius:4px; text-align:center;" title="Additional stock">
              <button class="btn-sm btn-add-stock" data-id="${f.id}" style="padding:0.25rem 0.4rem; font-size:0.75rem; background:var(--success); color:#fff; border:none;" title="Add stock"><i class="fas fa-plus"></i></button>
            </div>
          </td>
          <td>${isListed ? '<span class="badge badge-success">Listed for customers</span>' : '<span class="badge badge-warning">Admin stock only</span>'}</td>
          <td>
            <button class="btn-sm btn-toggle-listed" data-id="${f.id}" style="padding:0.3rem 0.5rem;">
              ${isListed ? 'Remove from Menu' : 'Add to Menu'}
            </button>
          </td>
          <td>
            <button class="btn-sm btn-delete-food" data-id="${f.id}" style="padding:0.3rem 0.5rem; background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);"><i class="fas fa-trash"></i></button>
          </td>
        `;

        tr.querySelector('.btn-save-stock').addEventListener('click', async () => {
          const inp = tr.querySelector('.stock-inline-edit');
          const offerInp = tr.querySelector('.offer-price-inline-edit');
          const newStock = parseInt(inp.value, 10);
          const newOfferStr = offerInp.value.trim();
          const newOfferPrice = newOfferStr === '' ? null : parseFloat(newOfferStr);

          if (isNaN(newStock) || newStock < 0) return alert("Invalid stock quantity");
          if (newOfferPrice !== null && (isNaN(newOfferPrice) || newOfferPrice < 0)) return alert("Invalid offer price");
          
          try {
            const res = await this.fetchWithAuth(`/api/food-items/${f.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: f.name,
                price: f.price,
                stock: newStock,
                category: f.category,
                isveg: f.isveg,
                image: f.image,
                details: f.details,
                offerPrice: newOfferPrice,
                listed: isListed
              })
            });

            if (res.ok) {
              await this.fetchFoodItems();
              this.renderTab(2);
              alert("Stock updated successfully!");
            }
          } catch (err) {
            console.error(err);
          }
        });

        tr.querySelector('.btn-add-stock').addEventListener('click', async () => {
          const amount = parseInt(tr.querySelector('.stock-add-input').value, 10);
          if (isNaN(amount) || amount <= 0) return alert("Enter a quantity greater than zero.");
          try {
            const res = await this.fetchWithAuth(`/api/food-items/${f.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: f.name, price: f.price, stock: f.stock + amount,
                category: f.category, isveg: f.isveg, image: f.image,
                details: f.details, offerPrice: f.offerPrice, listed: isListed
              })
            });
            if (!res.ok) throw new Error('Failed to add stock.');
            await this.fetchFoodItems();
            this.renderTab(2);
          } catch (err) {
            console.error(err);
            alert(err.message);
          }
        });

        tr.querySelector('.btn-toggle-listed').addEventListener('click', async () => {
          try {
            const res = await this.fetchWithAuth(`/api/food-items/${f.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: f.name, price: f.price, stock: f.stock,
                category: f.category, isveg: f.isveg, image: f.image,
                details: f.details, offerPrice: f.offerPrice, listed: !isListed
              })
            });
            if (!res.ok) throw new Error('Failed to update menu status.');
            await this.fetchFoodItems();
            this.renderTab(2);
          } catch (err) {
            console.error(err);
            alert(err.message);
          }
        });

        tr.querySelector('.btn-delete-food').addEventListener('click', async (event) => {
          const deleteButton = event.currentTarget;
          if (deleteButton.dataset.confirming !== 'true') {
            deleteButton.dataset.confirming = 'true';
            deleteButton.innerHTML = '<i class="fas fa-check"></i> Confirm';
            deleteButton.title = `Confirm deleting ${f.name}`;
            deleteButton.style.width = 'auto';
            deleteButton.style.padding = '0.3rem 0.5rem';

            const cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'btn-sm btn-cancel-delete';
            cancelButton.textContent = 'Cancel';
            cancelButton.style.cssText = 'margin-left:0.35rem; padding:0.3rem 0.5rem;';
            cancelButton.addEventListener('click', () => this.renderTab2());
            deleteButton.parentElement.appendChild(cancelButton);
            return;
          }

          deleteButton.disabled = true;
          deleteButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
          try {
            const res = await this.fetchWithAuth(`/api/food-items/${f.id}`, {
              method: 'DELETE'
            });
            if (res.ok) {
              await this.fetchFoodItems();
              this.renderTab(2);
            } else {
              deleteButton.disabled = false;
              deleteButton.dataset.confirming = 'false';
              deleteButton.innerHTML = '<i class="fas fa-trash"></i>';
            }
          } catch (err) {
            console.error(err);
            deleteButton.disabled = false;
            deleteButton.dataset.confirming = 'false';
            deleteButton.innerHTML = '<i class="fas fa-trash"></i>';
          }
        });

        tbody.appendChild(tr);
      });
    }



    // Prefill Special Offer config details
    fetch('/api/special-offer')
      .then(res => res.json())
      .then(offer => {
        if (offer) {
          const activeCB = document.getElementById('so-active');
          if (activeCB) activeCB.checked = !!offer.active;
          
          const titleInput = document.getElementById('so-title');
          if (titleInput) titleInput.value = offer.title || '';
          
          const descInput = document.getElementById('so-desc');
          if (descInput) descInput.value = offer.desc || '';
          
          const priceInput = document.getElementById('so-price');
          if (priceInput) priceInput.value = offer.price !== undefined ? offer.price : 90;
          
          const selectEl = document.getElementById('so-image-select');
          if (selectEl && offer.image) {
            let exists = false;
            for (let i = 0; i < selectEl.options.length; i++) {
              if (selectEl.options[i].value === offer.image) {
                exists = true;
                break;
              }
            }
            if (!exists) {
              const opt = document.createElement('option');
              opt.value = offer.image;
              opt.innerText = `${offer.image.split('/').pop()} (Saved)`;
              selectEl.appendChild(opt);
            }
            selectEl.value = offer.image;
          }
        }
      })
      .catch(e => console.warn("Failed to fetch special offer config:", e));
  },

  renderTab3() {
    // Render ingredients inventory table
    const ingTableBody = document.getElementById('tab3-ingredients-tbody');
    if (ingTableBody) {
      ingTableBody.innerHTML = '';
      if (this.ingredients.length === 0) {
        ingTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No materials cataloged.</td></tr>`;
      }
      this.ingredients.forEach(i => {
        const tr = document.createElement('tr');
        const formattedDate = i.lastPurchaseDate ? new Date(i.lastPurchaseDate).toLocaleString() : 'N/A';
        tr.innerHTML = `
          <td><strong>${i.name}</strong></td>
          <td>
            <span style="font-size:0.9rem; font-weight: 600;">${i.stock} ${i.unit}</span>
          </td>
          <td style="font-size: 0.85rem; color: var(--text-muted);">${formattedDate}</td>
          <td>
            <button class="btn-sm btn-delete-ing" data-id="${i.id}" style="padding:0.3rem 0.5rem; background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);"><i class="fas fa-trash"></i></button>
          </td>
        `;

        tr.querySelector('.btn-delete-ing').addEventListener('click', async () => {
          if (!confirm(`Delete ${i.name} from inventory?`)) return;
          try {
            const res = await this.fetchWithAuth(`/api/ingredients/${i.id}`, {
              method: 'DELETE'
            });
            if (res.ok) {
              await this.fetchIngredients();
              this.renderTab(3);
              alert("Material deleted from inventory.");
            } else {
              const errData = await res.json();
              alert(`Error: ${errData.error}`);
            }
          } catch (err) {
            console.error(err);
          }
        });

        ingTableBody.appendChild(tr);
      });
    }

    // Populate log forms selectors
    const purSelect = document.getElementById('tab1-pur-ing-id');
    if (purSelect) {
      const currentPur = purSelect.value;
      purSelect.innerHTML = '<option value="">-- Choose Material --</option>';
      this.ingredients.forEach(i => {
        purSelect.innerHTML += `<option value="${i.id}">${i.name} (Remaining: ${i.stock} ${i.unit})</option>`;
      });
      purSelect.value = currentPur;
    }

    // Initialize or refresh multi-product kitchen usage rows
    const container = document.getElementById('usage-products-container');
    if (container) {
      const existingRows = container.querySelectorAll('.usage-row');
      if (existingRows.length === 0) {
        this.addKitchenUsageRow();
      } else {
        this.updateKitchenUsageSelects();
      }
    }
  },

  renderTab4() {
    const ledgerBody = document.getElementById('tab3-transactions-tbody');
    if (!ledgerBody) return;

    ledgerBody.innerHTML = '';
    
    const masterCB = document.getElementById('ledger-select-all');
    if (masterCB) masterCB.checked = false;

    if (this.transactions.length === 0) {
      ledgerBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Ledger logs are empty.</td></tr>`;
      return;
    }

    this.transactions.forEach(t => {
      const tr = document.createElement('tr');
      const isSale = t.type === 'sale';
      const amountVal = isSale ? `+₹${t.amount}` : (t.type === 'purchase' ? `-₹${t.amount}` : `₹${t.amount}`);
      const badgeClass = isSale ? 'badge-success' : (t.type === 'purchase' ? 'badge-danger' : 'badge-warning');
      const timeStr = new Date(t.timestamp).toLocaleString();

      tr.innerHTML = `
        <td style="text-align: center;"><input type="checkbox" class="ledger-row-cb" data-id="${t.id}"></td>
        <td style="font-size: 0.8rem; color: var(--text-muted);">${timeStr}</td>
        <td><strong>${t.title}</strong><br><span style="font-size: 0.75rem; color:var(--text-muted);">${t.details || ''}</span></td>
        <td><span class="badge ${badgeClass}">${t.type.toUpperCase()}</span></td>
        <td><strong class="${isSale ? 'income' : 'expense'}">${amountVal}</strong></td>
        <td style="text-align: center;">
          <button class="btn-sm btn-delete-tx" data-id="${t.id}" style="padding: 0.25rem 0.4rem; background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);"><i class="fas fa-trash-alt"></i></button>
        </td>
      `;

      tr.querySelector('.btn-delete-tx').addEventListener('click', async () => {
        if (!confirm("Are you sure you want to delete this ledger transaction?")) return;
        try {
          const res = await this.fetchWithAuth(`/api/ledger/${t.id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            await this.fetchTransactions();
            this.renderTab(4);
            alert("Ledger transaction deleted.");
          }
        } catch (err) {
          console.error(err);
        }
      });

      ledgerBody.appendChild(tr);
    });

    // Prefill account profiles details
    document.getElementById('acc-name-input').value = this.accountDetails.name || '';
    document.getElementById('acc-upi-input').value = this.accountDetails.upiId || '';
    document.getElementById('acc-bank-input').value = this.accountDetails.bank || '';
    document.getElementById('acc-no-input').value = this.accountDetails.accNo || '';
    document.getElementById('acc-ifsc-input').value = this.accountDetails.ifsc || '';
    document.getElementById('acc-expiry-input').value = this.accountDetails.ticketExpiryHours || 5;

    // Prefill Razorpay config details
    fetch('/api/payments/config')
      .then(res => res.json())
      .then(config => {
        const keyIdInput = document.getElementById('rzp-key-id');
        if (keyIdInput && config.keyId) {
          keyIdInput.value = config.keyId;
        }
      })
      .catch(e => console.warn("Failed to fetch Razorpay config:", e));
  },

  renderTab6() {
    this.updateHistoryTableOnly();
    
    // Populate Report filter food item list
    const filterItemSelect = document.getElementById('report-filter-item');
    if (filterItemSelect) {
      const currentVal = filterItemSelect.value;
      filterItemSelect.innerHTML = '<option value="All">All Items</option>';
      this.foodItems.forEach(f => {
        filterItemSelect.innerHTML += `<option value="${f.id}">${f.name}</option>`;
      });
      filterItemSelect.value = currentVal;
    }

    this.updateSalesReportTable();
  },

  updateHistoryTableOnly() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;

    const events = this.getFilteredUnifiedHistoryEvents();

    tbody.innerHTML = '';
    if (events.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:1rem;">No history events match filters.</td></tr>`;
      return;
    }

    events.forEach(e => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      if (this.selectedHistoryId === e.id) {
        tr.style.background = 'rgba(27, 77, 62, 0.2)';
      }

      const timeStr = new Date(e.timestamp).toLocaleString();
      let catBadge = '';
      if (e.category === 'sales') {
        catBadge = '<span class="badge badge-success">SALE</span>';
      } else if (e.category === 'purchases') {
        catBadge = '<span class="badge badge-danger">PURCHASE</span>';
      } else if (e.category === 'usages') {
        catBadge = '<span class="badge badge-warning">USAGE</span>';
      } else {
        catBadge = '<span class="badge badge-info">OTHER</span>';
      }

      const isCredit = e.category === 'sales';
      const amountVal = isCredit ? `+₹${e.amount}` : (e.category === 'purchases' ? `-₹${e.amount}` : `₹${e.amount}`);
      
      tr.innerHTML = `
        <td style="font-size: 0.8rem; color: var(--text-muted);">${timeStr}</td>
        <td>${catBadge}</td>
        <td><strong>${e.title}</strong><br><span style="font-size: 0.75rem; color:var(--text-muted);">${e.details}</span></td>
        <td><strong class="${isCredit ? 'income' : (e.category === 'purchases' ? 'expense' : '')}">${amountVal}</strong></td>
      `;

      tr.addEventListener('click', () => {
        this.selectedHistoryId = e.id;
        tbody.querySelectorAll('tr').forEach(r => {
          r.style.background = '';
        });
        tr.style.background = 'rgba(27, 77, 62, 0.2)';
        this.showEventAuditDetails(e);
      });

      tbody.appendChild(tr);
    });
  },

  async showEventAuditDetails(item) {
    const panel = document.getElementById('history-audit-panel');
    if (!panel) return;

    const timeStr = new Date(item.timestamp).toLocaleString();
    let detailHTML = '';

    if (item.category === 'sales') {
      const b = this.bookings.find(booking => booking.bookingTime === item.timestamp);
      if (b) {
        const itemsList = b.items.map(i => `<li style="margin-bottom:0.25rem;">${i.name} x${i.quantity} <span style="color:var(--text-muted); font-size:0.75rem;">(₹${i.price} each)</span></li>`).join('');
        const statusBadge = this.getBookingStatusBadge(this.getBookingDisplayStatus(b));

        detailHTML = `
          <div style="display:flex; flex-direction:column; gap:1rem;">
            <div>
              <span style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Transaction ID</span>
              <div style="font-size:1.1rem; font-weight:700; color:var(--accent);">${item.id}</div>
            </div>
            <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
              <strong>Customer Particulars</strong>
              <div style="margin-top:0.25rem;">Name: ${b.customerName}</div>
              <div>Phone: ${b.customerPhone}</div>
              <div>Time: ${timeStr}</div>
              <div style="margin-top:0.25rem;">Status: ${statusBadge}</div>
              <div>Payment: ${b.paymentMethod} (${b.paymentStatus})</div>
            </div>
            <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
              <strong>Purchased Delights</strong>
              <ul style="margin-top:0.25rem; padding-left:1.25rem;">
                ${itemsList}
              </ul>
              <div style="font-size:1rem; font-weight:700; color:var(--accent); margin-top:0.5rem;">Total Amount: ₹${b.totalAmount}</div>
            </div>
            <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem; text-align:center;">
              <strong>Ticket Verification Barcode</strong>
              <div style="background:white; padding:0.75rem; border-radius:12px; display:inline-block; margin-top:0.5rem;">
                <canvas id="history-barcode-canvas" width="360" height="100"></canvas>
              </div>
            </div>
            <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem; display:flex; flex-direction:column; gap:0.5rem;">
              <button type="button" class="btn-sm btn-sm-accent w-full" id="btn-hist-download-receipt">
                <i class="fas fa-print"></i> Download Bill Receipt
              </button>
              ${b.status === 'pending' ? `
                <button type="button" class="btn-sm btn-sm-primary w-full" id="btn-hist-redeem-ticket" style="background:var(--success); color:#fff; border:none;">
                  <i class="fas fa-check-circle"></i> Redeem Food Ticket
                </button>
              ` : ''}
              <button type="button" class="btn-sm w-full" id="btn-hist-delete-tx" style="background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);">
                <i class="fas fa-trash-alt"></i> Delete Ledger Transaction
              </button>
            </div>
          </div>
        `;
      } else {
        detailHTML = this.getGenericTxHTML(item);
      }
    } else if (item.category === 'purchases') {
      detailHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem;">
          <div>
            <span style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Purchase ID</span>
            <div style="font-size:1.1rem; font-weight:700; color:var(--accent);">${item.id}</div>
          </div>
          <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
            <strong>Purchase Particulars</strong>
            <div style="margin-top:0.25rem;">Item: ${item.title}</div>
            <div>Deducted Value: <strong style="color:var(--text-red); font-size:1.1rem;">-₹${item.amount}</strong></div>
            <div>Invoice Details: ${item.details}</div>
            <div>Registered Time: ${timeStr}</div>
          </div>
          <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
            <button type="button" class="btn-sm w-full" id="btn-hist-delete-tx" style="background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);">
              <i class="fas fa-trash-alt"></i> Delete Ledger Transaction
            </button>
          </div>
        </div>
      `;
    } else if (item.category === 'usages') {
      const group = this.transactions.filter(tx => 
        tx.type === 'expense' && 
        tx.title.startsWith('Used in Kitchen -') && 
        Math.abs(new Date(tx.timestamp) - new Date(item.timestamp)) < 2000
      );

      const usageList = group.map(tx => `
        <li style="margin-bottom:0.25rem;">
          <strong>${tx.title.replace('Used in Kitchen - ', '')}</strong>: ${tx.details.replace('Used ', '')}
        </li>
      `).join('');

      detailHTML = `
        <div style="display:flex; flex-direction:column; gap:1rem;">
          <div>
            <span style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Usage Batch Log</span>
            <div style="font-size:1.1rem; font-weight:700; color:var(--accent);">${item.id}</div>
          </div>
          <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
            <strong>Deducted Ingredients Bullet List</strong>
            <ul style="margin-top:0.5rem; padding-left:1.25rem; line-height:1.6;">
              ${usageList}
            </ul>
            <div style="margin-top:0.75rem; font-size:0.8rem; color:var(--text-muted);">Time Logged: ${timeStr}</div>
          </div>
          <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
            <button type="button" class="btn-sm w-full" id="btn-hist-delete-tx" style="background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);">
              <i class="fas fa-trash-alt"></i> Delete Ledger Transaction
            </button>
          </div>
        </div>
      `;
    } else {
      detailHTML = this.getGenericTxHTML(item);
    }

    panel.innerHTML = detailHTML;

    if (item.category === 'sales') {
      const b = this.bookings.find(booking => booking.bookingTime === item.timestamp);
      if (b) {
        const canvas = document.getElementById('history-barcode-canvas');
        if (canvas) {
          try {
            await loadExternalScript('https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js');
            if (canvas.isConnected) {
              JsBarcode(canvas, b.id, {
                format: 'CODE128',
                lineColor: '#1b4d3e',
                background: '#ffffff',
                width: 1,
                height: 76,
                displayValue: false,
                margin: 8
              });
            }
          } catch (error) {
            console.error('Failed to load the ticket barcode generator:', error);
            canvas.insertAdjacentText('afterend', 'Ticket barcode could not be loaded.');
          }
        }

        const btnReceipt = document.getElementById('btn-hist-download-receipt');
        if (btnReceipt) {
          btnReceipt.addEventListener('click', () => downloadReceipt(b));
        }

        const btnRedeem = document.getElementById('btn-hist-redeem-ticket');
        if (btnRedeem) {
          btnRedeem.addEventListener('click', async () => {
            if (!confirm(`Redeem and close this food ticket ${b.id}?`)) return;
            try {
              const res = await this.fetchWithAuth('/api/bookings/redeem', {
                method: 'POST',
                body: JSON.stringify({ id: b.id })
              });
              if (res.ok) {
                alert("Ticket successfully redeemed!");
                await this.fetchBookings();
                const refreshed = this.bookings.find(booking => booking.id === b.id);
                if (refreshed) {
                  const updatedItem = { ...item, timestamp: refreshed.bookingTime };
                  this.showEventAuditDetails(updatedItem);
                }
                this.updateHistoryTableOnly();
              } else {
                const err = await res.json();
                alert(`Redemption failed: ${err.error}`);
              }
            } catch (err) {
              console.error(err);
            }
          });
        }
      }
    }

    const btnDelete = document.getElementById('btn-hist-delete-tx');
    if (btnDelete) {
      btnDelete.addEventListener('click', async () => {
        if (!confirm("Are you sure you want to delete this transaction from the ledger?")) return;
        try {
          const res = await this.fetchWithAuth(`/api/ledger/${item.id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            alert("Ledger transaction deleted successfully.");
            this.selectedHistoryId = null;
            panel.innerHTML = `
              <div style="text-align: center; color: var(--text-muted); padding: 2rem 0;">
                <i class="fas fa-info-circle" style="font-size: 2rem; margin-bottom: 0.75rem; display: block; color: var(--text-muted);"></i>
                Select any event row on the left to view detailed audit logs, print receipts, view ticket barcodes, or modify logs.
              </div>
            `;
            await this.fetchTransactions();
            this.updateHistoryTableOnly();
          } else {
            alert("Failed to delete transaction.");
          }
        } catch (err) {
          console.error(err);
        }
      });
    }
  },

  getGenericTxHTML(item) {
    const isCredit = item.category === 'sales' || item.rawTx.type === 'income' || item.rawTx.type === 'sale';
    const amountVal = isCredit ? `+₹${item.amount}` : `-₹${item.amount}`;
    const timeStr = new Date(item.timestamp).toLocaleString();
    return `
      <div style="display:flex; flex-direction:column; gap:1rem;">
        <div>
          <span style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Transaction ID</span>
          <div style="font-size:1.1rem; font-weight:700; color:var(--accent);">${item.id}</div>
        </div>
        <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
          <strong>Transaction Particulars</strong>
          <div style="margin-top:0.25rem;">Title: ${item.title}</div>
          <div>Type: <span class="badge badge-info">${item.rawTx.type.toUpperCase()}</span></div>
          <div>Amount: <strong class="${isCredit ? 'income' : 'expense'}" style="font-size:1.1rem;">${amountVal}</strong></div>
          <div>Details: ${item.details || 'N/A'}</div>
          <div>Time: ${timeStr}</div>
        </div>
        <div style="border-top: 1px dashed var(--border-dark); padding-top:0.75rem;">
          <button type="button" class="btn-sm w-full" id="btn-hist-delete-tx" style="background:rgba(234,67,53,0.1); color:#ea4335; border:1px solid rgba(234,67,53,0.2);">
            <i class="fas fa-trash-alt"></i> Delete Ledger Transaction
          </button>
        </div>
      </div>
    `;
  },

  exportUnifiedHistoryCSV() {
    const events = this.getFilteredUnifiedHistoryEvents();

    if (events.length === 0) return alert("Nothing to export.");

    let csv = "Timestamp,Category,Transaction ID,Description/Summary,Amount,Details\n";
    events.forEach(e => {
      const time = new Date(e.timestamp).toLocaleString().replace(/"/g, '""');
      const category = e.category.toUpperCase();
      const amountVal = e.category === 'sales' ? `+${e.amount}` : (e.category === 'purchases' ? `-${e.amount}` : `${e.amount}`);
      csv += `"${time}","${category}","${e.id}","${e.title.replace(/"/g, '""')}",${amountVal},"${e.details.replace(/"/g, '""')}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `n_cafe_unified_history_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  },

  getFilteredUnifiedHistoryEvents() {
    const filterType = document.getElementById('history-filter-type').value;
    const searchQuery = document.getElementById('history-search-input').value.trim().toLowerCase();
    const fromDate = document.getElementById('history-filter-from')?.value;
    const toDate = document.getElementById('history-filter-to')?.value;
    const fromTimestamp = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toTimestamp = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;

    let events = this.transactions.map(t => {
      let category = 'other';
      if (t.type === 'sale') {
        category = 'sales';
      } else if (t.type === 'purchase') {
        category = 'purchases';
      } else if (t.type === 'expense' && t.title.startsWith('Used in Kitchen -')) {
        category = 'usages';
      }

      return {
        id: t.id,
        timestamp: t.timestamp,
        category,
        title: t.title,
        amount: t.amount,
        details: t.details || '',
        rawTx: t
      };
    });

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (filterType !== 'All') {
      events = events.filter(e => e.category === filterType);
    }

    if (fromTimestamp !== null) {
      events = events.filter(e => new Date(e.timestamp).getTime() >= fromTimestamp);
    }

    if (toTimestamp !== null) {
      events = events.filter(e => new Date(e.timestamp).getTime() <= toTimestamp);
    }

    if (searchQuery) {
      events = events.filter(e => {
        const titleMatch = e.title.toLowerCase().includes(searchQuery);
        const detailsMatch = e.details.toLowerCase().includes(searchQuery);
        const amountMatch = e.amount.toString().includes(searchQuery);
        
        let bookingMatch = false;
        if (e.category === 'sales') {
          const matchingBooking = this.bookings.find(b => b.bookingTime === e.timestamp);
          if (matchingBooking) {
            bookingMatch = matchingBooking.customerName.toLowerCase().includes(searchQuery) ||
                           matchingBooking.customerPhone.toLowerCase().includes(searchQuery) ||
                           matchingBooking.id.toLowerCase().includes(searchQuery);
          }
        }
        return titleMatch || detailsMatch || amountMatch || bookingMatch;
      });
    }

    return events;
  },

  exportInventoryCSV() {
    if (this.ingredients.length === 0) return alert("Nothing to export.");
    let csv = "Ingredient ID,Material Name,Stock,Unit,Last Restocked Date\n";
    this.ingredients.forEach(i => {
      csv += `"${i.id}","${i.name}",${i.stock},"${i.unit}","${i.lastPurchaseDate || ''}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `n_cafe_inventory_status_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  },

  exportLedgerCSV() {
    let list = [];
    const checkboxes = document.querySelectorAll('.ledger-row-cb:checked');
    if (checkboxes.length > 0) {
      const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.id);
      list = this.transactions.filter(t => selectedIds.includes(t.id));
    } else {
      list = this.transactions;
    }

    if (list.length === 0) return alert("No transactions available for export.");

    let csv = "Transaction ID,Date/Time,Transaction,Type,Value,Particulars\n";
    list.forEach(t => {
      const time = new Date(t.timestamp).toLocaleString().replace(/"/g, '""');
      csv += `"${t.id}","${time}","${t.title.replace(/"/g, '""')}","${t.type}",${t.amount},"${(t.details || '').replace(/"/g, '""')}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `n_cafe_ledger_audit_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  }
};

// --- KITCHEN INGREDIENTS USAGE SLIP COMPILER (.TXT DOWNLOAD) ---
function downloadUsageSlip(updates) {
  if (!updates || updates.length === 0) return;
  const timeStr = new Date().toLocaleString();

  let detailsText = '';
  updates.forEach(up => {
    detailsText += `- ${up.ing.name}: ${up.qty} ${up.ing.unit} (Remaining: ${up.newStock.toFixed(1)} ${up.ing.unit})\n`;
  });

  const textContent = `
==================================================
        KITCHEN INGREDIENTS USAGE SLIP
==================================================
Date/Time:      ${timeStr}
Logged Action:  Kitchen Usage (Expense)
--------------------------------------------------
Details of Materials Used:
${detailsText}--------------------------------------------------
Status:         Logged & Deducted from Storage
==================================================
`;

  const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `kitchen_usage_slip_${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- WALK-IN RECEIPT / BILL COMPILER (.TXT DOWNLOAD) ---
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

// Wire up login form on page load
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('admin-login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('admin-login-password').value;
      const loginError = document.getElementById('admin-login-error');
      const showLoginError = (message) => {
        if (loginError) {
          loginError.textContent = message;
          loginError.style.display = 'block';
        }
      };
      if (loginError) loginError.style.display = 'none';
      try {
        const res = await fetch('/api/auth/login-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        if (res.ok) {
          const data = await res.json();
          localStorage.setItem('admin_token', data.token);
          document.getElementById('admin-login-password').value = '';
          AdminState.init();
        } else {
          const errData = await res.json().catch(() => ({}));
          showLoginError(errData.error || "Login failed. Please check your password and try again.");
        }
      } catch (err) {
        console.error(err);
        showLoginError("Unable to contact the server. Please try again.");
      }
    });
  }

  // Initialize
  AdminState.init();
});
