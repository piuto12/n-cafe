// N Cafe Customer Portal Controller
const CanteenState = {
  CUSTOMER_DATA_CACHE_TTL: 15 * 60 * 1000,
  foodItems: [],
  cart: [],
  retrievedTickets: [],
  activeBooking: null,
  retrievedTicketsTimerInterval: null,
  retrievedTicketsPollInProgress: false,
  accountDetails: {
    name: 'N Cafe Services',
    bank: 'State Bank of India',
    accNo: '39485710293',
    ifsc: 'SBIN0008472',
    upiId: 'ncafe.canteen@okaxis'
  },
  currentLockId: null,
  ticketTimerInterval: null,
  catalogRequest: null,
  catalogLoaded: false,
  catalogFetchedAt: 0,
  specialOfferRequest: null,
  specialOfferLoaded: false,

  async init() {
    this.loadCart();
    this.loadCachedCustomerData();

    // Bind click on Special Offer buy button
    const buyBtn = document.getElementById('btn-cust-offer-buy');
    if (buyBtn) {
      buyBtn.addEventListener('click', () => {
        addToCart('FD-SPECIAL');
        toggleCartDrawer(true);
      });
    }

    updateCartBadges();
    await Promise.all([
      this.fetchSettings(),
      this.fetchFoodCatalog({ force: true }),
      this.loadSpecialOffer()
    ]);
  },

  readCustomerCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(key));
      if (!cached || Date.now() - cached.savedAt > this.CUSTOMER_DATA_CACHE_TTL) return null;
      return cached.value;
    } catch (error) {
      return null;
    }
  },

  writeCustomerCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
    } catch (error) {
      console.warn('Unable to cache customer menu data:', error);
    }
  },

  loadCachedCustomerData() {
    const catalog = this.readCustomerCache('nc_customer_catalog_cache_v1');
    const settings = this.readCustomerCache('nc_customer_settings_cache_v1');
    const offer = this.readCustomerCache('nc_customer_offer_cache_v1');

    if (Array.isArray(catalog)) {
      this.foodItems = catalog;
      this.catalogLoaded = true;
      this.catalogFetchedAt = 0;
    }
    if (settings && typeof settings === 'object') {
      this.accountDetails = settings;
      this.applyAccountDetails();
    }
    if (offer && typeof offer === 'object') {
      this.specialOffer = offer;
      this.specialOfferLoaded = true;
    }
    if (this.catalogLoaded && this.specialOfferLoaded) {
      this.applySpecialOfferToCatalog();
    }
    if (this.catalogLoaded) this.renderCurrentMenu();
  },

  loadRazorpayScript() {
    return loadExternalScript('https://checkout.razorpay.com/v1/checkout.js');
  },

  loadCart() {
    try {
      this.cart = JSON.parse(localStorage.getItem('nc_customer_cart')) || [];
    } catch (e) {
      this.cart = [];
    }
  },

  saveCart() {
    localStorage.setItem('nc_customer_cart', JSON.stringify(this.cart));
    updateCartBadges();
  },

  async fetchSettings() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        this.accountDetails = await res.json();
        this.writeCustomerCache('nc_customer_settings_cache_v1', this.accountDetails);
        this.applyAccountDetails();
      }
    } catch (e) {
      console.warn("Failed to fetch settings from API, using default merchant particulars:", e);
    }
  },

  applyAccountDetails() {
    const logo = document.getElementById('customer-logo-image');
    if (logo && this.accountDetails.logoImage) {
      logo.src = this.accountDetails.logoImage;
      logo.style.display = 'block';
      const fallback = document.getElementById('customer-logo-fallback');
      if (fallback) fallback.style.display = 'none';
    }
    const logoContainer = document.querySelector('.logo-icon');
    if (logoContainer) {
      logoContainer.style.background = this.accountDetails.logoBackgroundColor || '#1b4d3e';
    }
    const hero = document.getElementById('customer-hero-banner');
    if (hero && this.accountDetails.heroBannerImage) {
      hero.style.setProperty('--hero-image', `url("${this.accountDetails.heroBannerImage}")`);
    }
  },

  async fetchFoodCatalog({ force = false } = {}) {
    if (this.catalogRequest) return this.catalogRequest;
    if (!force && this.catalogLoaded && Date.now() - this.catalogFetchedAt < 30000) {
      return;
    }

    this.catalogRequest = (async () => {
      try {
        const res = await fetch('/api/food-items');
        if (!res.ok) throw new Error(`Catalog request failed (${res.status}).`);
        this.foodItems = await res.json();
        this.writeCustomerCache('nc_customer_catalog_cache_v1', this.foodItems);
        this.catalogLoaded = true;
        this.catalogFetchedAt = Date.now();
        if (this.specialOfferLoaded) {
          this.applySpecialOfferToCatalog();
          this.syncCartWithCatalog();
        }
        this.renderCurrentMenu();
      } catch (e) {
        console.error("Failed to load catalog from API:", e);
        if (!this.catalogLoaded) {
          const menuGrid = document.getElementById('food-menu-grid');
          if (menuGrid) {
            menuGrid.setAttribute('aria-busy', 'false');
            menuGrid.innerHTML = '<p class="catalog-load-error" role="status">The menu could not be loaded. Please try again later.</p>';
          }
        }
      } finally {
        this.catalogRequest = null;
      }
    })();
    return this.catalogRequest;
  },

  renderCurrentMenu() {
    const activeCategory = document.querySelector('.cat-btn.active');
    const searchInput = document.getElementById('search-food');
    renderFoodMenu(activeCategory ? activeCategory.dataset.category : 'all', searchInput ? searchInput.value : '');
  },

  applySpecialOfferToCatalog() {
    const banner = document.getElementById('customer-special-offer-banner');
    const offer = this.specialOffer;
    this.foodItems = this.foodItems.filter(food => food.id !== 'FD-SPECIAL');

    if (offer && offer.active) {
      document.getElementById('cust-offer-title').textContent = offer.title || '';
      document.getElementById('cust-offer-desc').textContent = offer.desc || '';
      document.getElementById('cust-offer-price').textContent = `₹${offer.price}`;

      const image = document.getElementById('cust-offer-img');
      if (image) image.src = offer.image || 'assets/south_indian_meals.png';
      if (banner) banner.style.display = 'grid';

      this.foodItems.push({
        id: 'FD-SPECIAL',
        name: offer.title || 'Special Offer Combo',
        price: Number(offer.price) || 0,
        image: offer.image || 'assets/south_indian_meals.png',
        details: offer.desc || '',
        category: 'Snacks',
        isveg: 'Veg',
        availableStock: 9999
      });
    } else if (banner) {
      banner.style.display = 'none';
    }
  },

  async loadSpecialOffer() {
    if (this.specialOfferRequest) return this.specialOfferRequest;

    this.specialOfferRequest = (async () => {
      try {
        const res = await fetch('/api/special-offer');
        if (res.ok) {
          this.specialOffer = await res.json();
          this.writeCustomerCache('nc_customer_offer_cache_v1', this.specialOffer);
        }
      } catch (e) {
        console.warn("Failed to load special offer settings:", e);
      } finally {
        this.specialOfferLoaded = true;
        if (this.catalogLoaded) {
          this.applySpecialOfferToCatalog();
          this.syncCartWithCatalog();
          this.renderCurrentMenu();
        }
        this.specialOfferRequest = null;
      }
    })();
    return this.specialOfferRequest;
  },

  syncCartWithCatalog() {
    const availableItems = new Map(
      this.foodItems
        .filter(food => food.id === 'FD-SPECIAL' || Number(food.availableStock) > 0)
        .map(food => [food.id, food])
    );
    const syncedCart = [];

    this.cart.forEach(cartItem => {
      const food = availableItems.get(cartItem.id);
      if (!food) return;

      const quantity = Math.min(
        Math.max(0, Number(cartItem.quantity) || 0),
        Number(food.availableStock)
      );
      if (quantity > 0) {
        syncedCart.push({ ...cartItem, quantity });
      }
    });

    const changed = JSON.stringify(syncedCart) !== JSON.stringify(this.cart);
    this.cart = syncedCart;
    if (changed) this.saveCart();
  }
};

const AppRouter = {
  currentTab: 'home',

  navigateTo(view) {
    this.currentTab = view;
    const cartButton = document.getElementById('cart-toggle-btn');
    if (cartButton) cartButton.hidden = view !== 'home';

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    document.querySelectorAll('.role-section').forEach(sec => {
      sec.style.display = 'none';
    });

    const activeSec = document.getElementById('customer-section');
    if (activeSec) activeSec.style.display = 'block';

    document.querySelectorAll('.customer-tab-view').forEach(v => {
      v.style.display = v.id === `view-${view}` ? 'block' : 'none';
    });

    const subNav = document.getElementById('customer-sub-nav');
    if (subNav) {
      subNav.style.display = view === 'home' ? 'block' : 'none';
    }

    if (view === 'ticket') {
      renderTicketPage();
    } else if (view === 'home') {
      CanteenState.fetchFoodCatalog().then(() => CanteenState.renderCurrentMenu());
    }
  },

  openTicketRetrievalGate() {
    if (CanteenState.retrievedTicketsTimerInterval) {
      clearInterval(CanteenState.retrievedTicketsTimerInterval);
      CanteenState.retrievedTicketsTimerInterval = null;
    }
    document.getElementById('cust-retrieval-name').value = '';
    document.getElementById('cust-retrieval-passkey').value = '';
    const panel = document.getElementById('retrieval-results-panel');
    if (panel) panel.style.display = 'none';
    const feedback = document.getElementById('retrieval-feedback');
    if (feedback) {
      feedback.textContent = '';
      feedback.style.display = 'none';
    }
    document.getElementById('ticket-retrieval-gate').classList.add('active');
  },

  closeTicketRetrievalGate() {
    if (CanteenState.retrievedTicketsTimerInterval) {
      clearInterval(CanteenState.retrievedTicketsTimerInterval);
      CanteenState.retrievedTicketsTimerInterval = null;
    }
    document.getElementById('ticket-retrieval-gate').classList.remove('active');
  }
};

// --- MENU RENDERING LOGIC ---
function renderFoodMenu(filterCategory = 'all', searchQuery = '') {
  const menuGrid = document.getElementById('food-menu-grid');
  if (!menuGrid) return;
  menuGrid.setAttribute('aria-busy', 'false');
  menuGrid.innerHTML = '';

  // Filter out the special offer combo so it doesn't render in main list
  let filtered = CanteenState.foodItems.filter(f => f.id !== 'FD-SPECIAL' && f.availableStock > 0);

  if (filterCategory.toLowerCase() !== 'all') {
    filtered = filtered.filter(f => f.category.toLowerCase() === filterCategory.toLowerCase());
  }

  if (searchQuery.trim() !== '') {
    const q = searchQuery.toLowerCase().trim();
    filtered = filtered.filter(f => f.name.toLowerCase().includes(q) || (f.details && f.details.toLowerCase().includes(q)));
  }

  if (filtered.length === 0) {
    menuGrid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 3rem; text-align: center; color: var(--text-muted);">
        <i class="fas fa-search" style="font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.5;"></i>
        <p>No culinary delights match your active filter.</p>
      </div>
    `;
    return;
  }

  filtered.forEach(f => {
    const isOutOfStock = f.availableStock <= 0;
    const tagClass = f.isveg === 'Veg' || f.isveg === 'true' ? 'tag-veg' : 'tag-non-veg';
    const vegBadge = f.isveg === 'Veg' || f.isveg === 'true' ? 'veg' : 'nonveg';
    const vegIcon = f.isveg === 'Veg' || f.isveg === 'true' ? 'fa-leaf' : 'fa-drumstick-bite';
    
    // Check if item is already in cart
    const cartItem = CanteenState.cart.find(c => c.id === f.id);
    const cartQty = cartItem ? cartItem.quantity : 0;

    const card = document.createElement('div');
    card.className = `food-card ${isOutOfStock ? 'out-of-stock' : ''}`;
    card.dataset.foodId = f.id;
    card.innerHTML = `
      <div class="food-card-img-wrapper">
        <img src="${f.image}" alt="${f.name}" loading="lazy" decoding="async" onerror="this.src='https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=500'">
        <span class="food-card-tag ${tagClass}"><i class="fas ${vegIcon}"></i></span>
        ${isOutOfStock ? '<div class="stock-overlay-label">SOLD OUT</div>' : ''}
      </div>
      <div class="food-card-info">
        <div class="food-card-title-row">
          <h3>${f.name}</h3>
          <span class="food-card-price">
            ${(f.offerPrice && f.offerPrice < f.price) ? `<span style="text-decoration: line-through; color: var(--text-muted); font-size: 0.85em; margin-right: 0.5rem;">₹${f.price}</span><span style="color: var(--accent); font-weight: 800; font-size: 1.15em;">₹${f.offerPrice}</span>` : `₹${f.price}`}
          </span>
        </div>
        <p class="food-card-desc">${f.details || 'Fresh daily special gourmet preparation.'}</p>
        
        <div class="food-card-footer">
          <span class="food-stock-status ${isOutOfStock ? 'stock-out' : (f.availableStock < 5 ? 'stock-low' : 'stock-good')}">
            ${isOutOfStock ? 'Sold Out' : `Only ${f.availableStock} portions left`}
          </span>
          
          ${isOutOfStock ? `
            <button class="btn-add-cart" disabled>Sold Out</button>
          ` : (cartQty > 0 ? `
            <div class="cart-item-qty-control">
              <button onclick="adjustCartQty('${f.id}', -1)" class="qty-btn"><i class="fas fa-minus"></i></button>
              <span style="font-weight: 600; min-width: 20px; text-align: center;">${cartQty}</span>
              <button onclick="adjustCartQty('${f.id}', 1)" class="qty-btn"><i class="fas fa-plus"></i></button>
            </div>
          ` : `
            <button onclick="addToCart('${f.id}')" class="btn-add-cart"><i class="fas fa-plus"></i> Add Portion</button>
          `)}
        </div>
      </div>
    `;
    menuGrid.appendChild(card);
  });
}

function addToCart(foodId) {
  const food = CanteenState.foodItems.find(f => f.id === foodId);
  if (!food) return;

  const sourceImage = Array.from(document.querySelectorAll('.food-card'))
    .find(card => card.dataset.foodId === foodId)?.querySelector('img');
  const sourceRect = sourceImage ? sourceImage.getBoundingClientRect() : null;
  const sourceImageUrl = sourceImage ? (sourceImage.currentSrc || sourceImage.src) : null;
  const cartButton = document.getElementById('cart-toggle-btn');
  const cartRect = cartButton ? cartButton.getBoundingClientRect() : null;
  const cartItem = CanteenState.cart.find(c => c.id === foodId);
  let added = false;
  if (cartItem) {
    if (cartItem.quantity < food.availableStock) {
      cartItem.quantity++;
      added = true;
    } else {
      alert(`Limit exceeded. Only ${food.availableStock} portions available in stock.`);
    }
  } else {
    CanteenState.cart.push({ id: foodId, quantity: 1 });
    added = true;
  }

  CanteenState.saveCart();
  const activeCat = document.querySelector('.cat-btn.active');
  const searchVal = document.getElementById('search-food').value;
  renderFoodMenu(activeCat ? activeCat.dataset.category : 'all', searchVal);
  if (added) animateCartAdd(sourceRect, sourceImageUrl, cartRect);
}

function animateCartAdd(sourceRect, sourceImageUrl, cartRect) {
  const cartButton = document.getElementById('cart-toggle-btn');
  if (!cartButton) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    cartButton.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(1.2)', offset: 0.45 },
      { transform: 'scale(1)' }
    ], {
      duration: 450,
      easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
    });
  }

  if (!sourceRect || !sourceImageUrl || !cartRect || reduceMotion) return;

  const sourceX = sourceRect.left + sourceRect.width / 2;
  const sourceY = sourceRect.top + sourceRect.height / 2;
  const cartX = cartRect.left + cartRect.width / 2;
  const cartY = cartRect.top + cartRect.height / 2;
  const flyingImage = document.createElement('img');
  flyingImage.src = sourceImageUrl;
  flyingImage.alt = '';
  flyingImage.setAttribute('aria-hidden', 'true');
  Object.assign(flyingImage.style, {
    position: 'fixed',
    left: `${sourceX}px`,
    top: `${sourceY}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    objectFit: 'cover',
    borderRadius: '12px',
    pointerEvents: 'none',
    zIndex: '1200',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)'
  });
  document.body.appendChild(flyingImage);

  const animation = flyingImage.animate([
    {
      transform: 'translate(0px, 0px) translate(-50%, -50%) scale(1)',
      opacity: 1
    },
    {
      transform: `translate(${cartX - sourceX}px, ${cartY - sourceY}px) translate(-50%, -50%) scale(0.15)`,
      opacity: 0.2
    }
  ], {
    duration: 650,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'forwards'
  });
  animation.onfinish = () => flyingImage.remove();
  animation.oncancel = () => flyingImage.remove();
}

function adjustCartQty(foodId, amount) {
  const food = CanteenState.foodItems.find(f => f.id === foodId);
  const cartItem = CanteenState.cart.find(c => c.id === foodId);
  if (!cartItem || !food) return;

  const targetQty = cartItem.quantity + amount;
  if (targetQty <= 0) {
    CanteenState.cart = CanteenState.cart.filter(c => c.id !== foodId);
  } else if (amount < 0 || targetQty <= food.availableStock) {
    cartItem.quantity = targetQty;
  } else {
    alert(`Limit exceeded. Only ${food.availableStock} portions available in stock.`);
  }

  CanteenState.saveCart();
  const activeCat = document.querySelector('.cat-btn.active');
  const searchVal = document.getElementById('search-food').value;
  renderFoodMenu(activeCat ? activeCat.dataset.category : 'all', searchVal);
}

function updateCartBadges() {
  const count = CanteenState.cart.reduce((sum, item) => sum + item.quantity, 0);
  const badges = document.querySelectorAll('.cart-badge');
  badges.forEach(b => {
    b.textContent = count;
    b.style.display = count > 0 ? 'flex' : 'none';
  });
}

// --- CART DRAWER & CHECKOUT VIEW ---
function toggleCartDrawer(open) {
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-backdrop');
  if (!drawer || !backdrop) return;

  if (open) {
    renderCartItems();
    drawer.classList.add('open');
    backdrop.classList.add('active');
  } else {
    drawer.classList.remove('open');
    backdrop.classList.remove('active');
  }
}

function renderCartItems() {
  const container = document.getElementById('cart-items-list');
  const subtotalDisplay = document.getElementById('cart-subtotal');
  const taxDisplay = document.getElementById('cart-tax');
  const totalDisplay = document.getElementById('cart-total');
  if (!container) return;
  container.innerHTML = '';

  let subtotal = 0;
  
  if (CanteenState.cart.length === 0) {
    container.innerHTML = `
      <div style="padding: 3rem; text-align: center; color: var(--text-muted);">
        <i class="fas fa-shopping-basket" style="font-size: 2.5rem; margin-bottom: 0.75rem; opacity: 0.3;"></i>
        <p>Your cart is empty.</p>
        <p style="font-size: 0.75rem; margin-top: 0.25rem;">Browse menu to add items.</p>
      </div>
    `;
    if (subtotalDisplay) subtotalDisplay.innerText = '₹0';
    if (taxDisplay) taxDisplay.innerText = '₹0';
    if (totalDisplay) totalDisplay.innerText = '₹0';
    return;
  }

  CanteenState.cart.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    if (!food) return;

    const hasOffer = food.offerPrice && food.offerPrice < food.price;
    const activePrice = hasOffer ? food.offerPrice : food.price;
    const rowTotal = activePrice * cItem.quantity;
    subtotal += rowTotal;

    const row = document.createElement('div');
    row.className = 'cart-item';
    
    const priceDisplayHTML = hasOffer 
      ? `<span style="text-decoration: line-through; color: var(--text-muted); margin-right: 0.4rem;">₹${food.price}</span><strong style="color: var(--accent);">₹${food.offerPrice}</strong>` 
      : `₹${food.price}`;

    row.innerHTML = `
      <img src="${food.image}" alt="${food.name}" class="cart-item-img" onerror="this.src='https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=500'">
      <div class="cart-item-detail">
        <div class="cart-item-name">${food.name}</div>
        <div class="cart-item-price">${priceDisplayHTML} &times; ${cItem.quantity} = ₹${rowTotal}</div>
        <div class="cart-item-qty-control">
          <button onclick="adjustCartQty('${food.id}', -1); renderCartItems();" class="qty-btn"><i class="fas fa-minus"></i></button>
          <span style="font-weight: 600; min-width: 20px; text-align: center;">${cItem.quantity}</span>
          <button onclick="adjustCartQty('${food.id}', 1); renderCartItems();" class="qty-btn"><i class="fas fa-plus"></i></button>
        </div>
      </div>
      <button onclick="CanteenState.cart = CanteenState.cart.filter(c => c.id !== '${food.id}'); CanteenState.saveCart(); renderCartItems();" class="cart-item-remove" title="Remove item">
        <i class="fas fa-trash-alt"></i>
      </button>
    `;
    container.appendChild(row);
  });

  const tax = 0;
  const total = subtotal;
  if (subtotalDisplay) subtotalDisplay.innerText = `₹${subtotal}`;
  if (taxDisplay) taxDisplay.innerText = `₹${tax}`;
  if (totalDisplay) totalDisplay.innerText = `₹${total}`;
}

function openCheckoutSummary() {
  if (CanteenState.cart.length === 0) {
    alert('Your cart is empty!');
    return;
  }

  toggleCartDrawer(false);
  AppRouter.navigateTo('checkout');

  const summary = document.getElementById('checkout-items-summary');
  if (!summary) return;
  summary.innerHTML = '';

  let subtotal = 0;
  CanteenState.cart.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    if (!food) return;
    const hasOffer = food.offerPrice && food.offerPrice < food.price;
    const activePrice = hasOffer ? food.offerPrice : food.price;
    const rowTotal = activePrice * cItem.quantity;
    subtotal += rowTotal;

    const row = document.createElement('div');
    row.className = 'flex justify-between';
    row.style.fontSize = '0.85rem';
    row.style.marginBottom = '0.4rem';
    row.innerHTML = `
      <span>${food.name} <strong style="color: var(--accent);">x${cItem.quantity}</strong> ${hasOffer ? '<span style="font-size:0.75rem; color:var(--accent); background:rgba(212,163,115,0.15); padding:1px 5px; border-radius:10px; margin-left:4px;">Offer</span>' : ''}</span>
      <span>₹${rowTotal}</span>
    `;
    summary.appendChild(row);
  });

  const tax = 0;
  const total = subtotal;

  document.getElementById('checkout-subtotal').innerText = `₹${subtotal}`;
  document.getElementById('checkout-tax').innerText = `₹${tax}`;
  document.getElementById('checkout-total').innerText = `₹${total}`;

  // Prefill inputs
  document.getElementById('cust-name').value = localStorage.getItem('nc_last_cust_name') || '';
  document.getElementById('cust-phone').value = localStorage.getItem('nc_last_cust_phone') || '';
  document.getElementById('cust-passkey').value = '';

  document.getElementById('checkout-form-details').style.display = 'block';
  document.getElementById('btn-place-order').style.display = 'block';
  document.getElementById('payment-simulation-container').style.display = 'none';
}

// --- CHECKOUT SUBMISSION & LOCKS ---
document.getElementById('checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const passkey = document.getElementById('cust-passkey').value.trim();

  if (!name || !phone || !passkey) {
    alert('Please prefill all details.');
    return;
  }

  // 1. Double check stock dynamically from server catalog
  await CanteenState.fetchFoodCatalog({ force: true });
  let stockIssues = [];
  CanteenState.cart.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    if (!food || food.availableStock < cItem.quantity) {
      stockIssues.push(`${food ? food.name : 'Item'} (Only ${food ? food.availableStock : 0} portions available)`);
    }
  });

  if (stockIssues.length > 0) {
    alert(`Some items in your cart are no longer available in the requested quantities. Please review:\n\n${stockIssues.join('\n')}`);
    AppRouter.navigateTo('home');
    return;
  }

  // 2. Request temporary stock lock from server
  try {
    const res = await fetch('/api/locks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cartItems: CanteenState.cart })
    });
    if (res.ok) {
      const data = await res.json();
      CanteenState.currentLockId = data.lockId;
      
      // Save customer details to local storage
      localStorage.setItem('nc_last_cust_name', name);
      localStorage.setItem('nc_last_cust_phone', phone);

      // Check if Razorpay is enabled on the server
      fetch('/api/payments/config')
        .then(async configRes => {
          if (configRes.ok) {
            const config = await configRes.json();
            if (config.enabled) {
              await CanteenState.loadRazorpayScript();
              if (typeof Razorpay === 'undefined') {
                throw new Error('Razorpay checkout script loaded without initializing.');
              }

              // Construct booking payload
              const subtotalText = document.getElementById('checkout-subtotal').innerText.replace('₹', '');
              const subtotal = parseFloat(subtotalText);
              const tax = 0;
              const total = subtotal;

              const itemsBreakdown = [];
              CanteenState.cart.forEach(cItem => {
                const food = CanteenState.foodItems.find(f => f.id === cItem.id);
                if (food) {
                  itemsBreakdown.push({
                    foodItemId: food.id,
                    name: food.name,
                    quantity: cItem.quantity,
                    price: food.price
                  });
                }
              });

              const bookingData = {
                id: generateTicketToken(),
                customerName: name,
                customerPhone: phone,
                passkey: passkey,
                items: itemsBreakdown,
                totalAmount: total,
                lockId: data.lockId
              };

              // Start reservation timer
              startCheckoutReservationTimer(data.lockId);

              // Launch real Razorpay modal
              processRazorpayCheckout(bookingData, config.keyId);
              return;
            }
          }

          await cancelPaymentGateway(false);
          alert('Online payment is not configured. Please contact the cafe administrator.');
        })
        .catch(err => {
          console.warn("Payments configuration or checkout could not be loaded:", err);
          cancelPaymentGateway(false).then(() => {
            alert('Unable to load online payment checkout. Please try again later.');
          });
        });
    } else {
      alert('Failed to reserve food stock. Please try again.');
    }
  } catch (err) {
    console.error(err);
    alert('Error connecting to backend server.');
  }
});

// --- GATEWAY COUNTDOWN TIMER ---
let checkoutTimerInterval = null;
function startCheckoutReservationTimer(lockId) {
  if (checkoutTimerInterval) clearInterval(checkoutTimerInterval);

  let secondsLeft = 300; // 5 Minutes
  const display = document.getElementById('checkout-reserve-timer');
  if (display) display.innerText = "Reserved: 05:00";

  checkoutTimerInterval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      clearInterval(checkoutTimerInterval);
      alert('Your 5-minute stock hold reservation has expired! Returning to menu.');
      cancelPaymentGateway();
    } else {
      const mins = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
      const secs = (secondsLeft % 60).toString().padStart(2, '0');
      if (display) display.innerText = `Reserved: ${mins}:${secs}`;
    }
  }, 1000);
}

async function cancelPaymentGateway(showAlert = true) {
  if (checkoutTimerInterval) {
    clearInterval(checkoutTimerInterval);
    checkoutTimerInterval = null;
  }

  if (CanteenState.currentLockId) {
    try {
      await fetch('/api/locks/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lockId: CanteenState.currentLockId })
      });
    } catch (e) {
      console.error(e);
    }
    CanteenState.currentLockId = null;
  }

  if (showAlert) {
    alert('Payment checkout cancelled. Portions returned to menu.');
  }
  AppRouter.navigateTo('home');
}

window.addEventListener('pagehide', () => {
  if (!CanteenState.currentLockId || !navigator.sendBeacon) return;

  const payload = new Blob(
    [JSON.stringify({ lockId: CanteenState.currentLockId })],
    { type: 'application/json' }
  );
  navigator.sendBeacon('/api/locks/release', payload);
  CanteenState.currentLockId = null;
});

// --- UPI PAYMENT GATEWAY INTERACTIVE INTERFACE ---
let selectedGatewayTab = 'qr';
async function initPaymentGatewaySandbox() {
  const amountVal = parseFloat(document.getElementById('checkout-total').innerText.replace('₹', ''));
  const name = document.getElementById('cust-name').value.trim();
  
  const merchantName = CanteenState.accountDetails.name;
  const merchantUpi = CanteenState.accountDetails.upiId;

  // Build upi URI deep-link
  const upiLink = `upi://pay?pa=${merchantUpi}&pn=${encodeURIComponent(merchantName)}&am=${amountVal}&cu=INR&tn=${encodeURIComponent('N-Cafe-Order')}`;
  
  document.getElementById('npay-upi-merchant').innerText = merchantName;
  document.getElementById('npay-upi-vpa').innerText = merchantUpi;

  // Render QR Canvas
  const qrCanvas = document.getElementById('npay-qr-canvas');
  if (qrCanvas) {
    await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js');
    new QRious({
      element: qrCanvas,
      value: upiLink,
      size: 180,
      background: '#ffffff',
      foreground: '#000000'
    });
  }

  const mobileUpiBtn = document.getElementById('npay-mobile-upi-btn');
  if (mobileUpiBtn) {
    mobileUpiBtn.href = upiLink;
  }

  switchGatewayTab('qr');
}

function switchGatewayTab(tab) {
  selectedGatewayTab = tab;
  document.querySelectorAll('.npay-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.npay-tab-content-panel').forEach(p => {
    p.style.display = p.id === `npay-panel-${tab}` ? 'block' : 'none';
  });
}

// --- OTP TRIGGER SIMULATION ---
let generatedOTP = '';
document.getElementById('btn-npay-vpa-request').addEventListener('click', () => {
  const vpa = document.getElementById('gateway-vpa-input').value.trim();
  if (!vpa || !vpa.includes('@')) {
    alert('Please enter a valid UPI ID (VPA).');
    return;
  }

  const pushLoader = document.getElementById('npay-loader-screen');
  const pushLabel = document.getElementById('npay-loader-label');
  
  pushLoader.classList.add('active');
  pushLabel.innerText = "Transmitting push request notification...";

  setTimeout(() => {
    pushLabel.innerText = "Securing transaction authorization...";
  }, 1500);

  setTimeout(() => {
    pushLoader.classList.remove('active');
    openOTPChallengeModal();
  }, 3000);
});

function openOTPChallengeModal() {
  const overlay = document.getElementById('otp-modal-overlay');
  overlay.classList.add('active');
  
  document.querySelectorAll('.otp-field').forEach(f => f.value = '');

  generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
  document.getElementById('simulated-otp-code').innerText = generatedOTP;

  const fields = document.querySelectorAll('.otp-field');
  fields[0].focus();

  fields.forEach((field, index) => {
    field.oninput = () => {
      if (field.value.length === 1 && index < fields.length - 1) {
        fields[index + 1].focus();
      }
    };
  });
}

document.getElementById('btn-otp-cancel').addEventListener('click', () => {
  document.getElementById('otp-modal-overlay').classList.remove('active');
});

document.getElementById('btn-otp-submit').addEventListener('click', () => {
  const fields = document.querySelectorAll('.otp-field');
  let typed = '';
  fields.forEach(f => typed += f.value.trim());

  if (typed === generatedOTP) {
    document.getElementById('otp-modal-overlay').classList.remove('active');
    finalizeCanteenOrder('UPI Push Request');
  } else {
    alert('Incorrect verification passcode code. Please check SMS simulation and enter again.');
  }
});

// --- FINALIZE ORDER & POST TO DATABASE ---
async function finalizeCanteenOrder(paymentMethodText) {
  if (checkoutTimerInterval) {
    clearInterval(checkoutTimerInterval);
    checkoutTimerInterval = null;
  }

  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const passkey = document.getElementById('cust-passkey').value.trim();
  
  const subtotalText = document.getElementById('checkout-subtotal').innerText.replace('₹', '');
  const subtotal = parseFloat(subtotalText);
  const tax = 0;
  const total = subtotal;

  const itemsBreakdown = [];
  CanteenState.cart.forEach(cItem => {
    const food = CanteenState.foodItems.find(f => f.id === cItem.id);
    if (food) {
      const activePrice = (food.offerPrice && food.offerPrice < food.price) ? food.offerPrice : food.price;
      itemsBreakdown.push({
        foodItemId: food.id,
        name: food.name,
        quantity: cItem.quantity,
        price: activePrice
      });
    }
  });

  // Generate a compact 20-character alphanumeric ticket ID.
  const bookingId = generateTicketToken();

  const payload = {
    id: bookingId,
    customerName: name,
    customerPhone: phone,
    passkey,
    items: itemsBreakdown,
    totalAmount: total,
    paymentMethod: paymentMethodText,
    lockId: CanteenState.currentLockId
  };

  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      const ticketHours = CanteenState.accountDetails.ticketExpiryHours || 5;
      CanteenState.activeBooking = {
        ...payload,
        bookingTime: new Date().toISOString(),
        expiryTime: new Date(Date.now() + ticketHours * 3600 * 1000).toISOString(),
        status: 'pending'
      };

      CanteenState.cart = [];
      CanteenState.currentLockId = null;
      CanteenState.saveCart();

      AppRouter.navigateTo('ticket');
    } else {
      const errData = await res.json();
      alert(`Booking Failed: ${errData.error || 'Check stock levels.'}`);
      AppRouter.navigateTo('home');
    }
  } catch (err) {
    console.error(err);
    alert('Error connecting to backend database.');
  }
}

function generateTicketToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = 'NC-';
  for (let i = 0; i < 17; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// --- TICKET PAGE TICK & COUNTDOWN DISPLAY ---
function renderTicketPage() {
  const b = CanteenState.activeBooking;
  if (!b) {
    AppRouter.navigateTo('home');
    return;
  }

  document.getElementById('ticket-id').innerText = b.id;
  document.getElementById('ticket-cust-name').innerText = b.customerName;
  document.getElementById('ticket-cust-phone').innerText = b.customerPhone;
  document.getElementById('ticket-time').innerText = new Date(b.bookingTime).toLocaleString();

  const itemsContainer = document.getElementById('ticket-items-list');
  itemsContainer.innerHTML = '';
  
  b.items.forEach(i => {
    const row = document.createElement('div');
    row.className = 'ticket-item-row';
    row.innerHTML = `
      <span>${i.name} <span class="qty">x${i.quantity}</span></span>
      <span>₹${i.price * i.quantity}</span>
    `;
    itemsContainer.appendChild(row);
  });

  const tax = 0;
  const sub = b.totalAmount;
  document.getElementById('ticket-subtotal').innerText = `₹${sub}`;
  document.getElementById('ticket-tax').innerText = `₹${tax}`;
  document.getElementById('ticket-total').innerText = `₹${b.totalAmount}`;

  // Render a CODE128 barcode containing the self-contained booking payload.
  renderTicketBarcode(b);
  document.getElementById('barcode-num-text').innerText = b.id;

  // Clear existing timer
  if (CanteenState.ticketTimerInterval) clearInterval(CanteenState.ticketTimerInterval);

  const tick = async () => {
    // Poll the backend to check if the ticket has been redeemed
    try {
      // Find this ticket in list
      const res = await fetch(`/api/bookings/status/${b.id}`);
      if (res.ok) {
        const current = await res.json();
        if (current) {
          const overlayExpired = document.getElementById('ticket-overlay-expired');
          const overlayRedeemed = document.getElementById('ticket-overlay-redeemed');
          const overlayCancelled = document.getElementById('ticket-overlay-cancelled');
          const timerDisplay = document.getElementById('ticket-timer-display');

          if (current.status === 'cancelled') {
            overlayCancelled.style.display = 'flex';
            overlayExpired.style.display = 'none';
            overlayRedeemed.style.display = 'none';
            timerDisplay.style.display = 'none';
            clearInterval(CanteenState.ticketTimerInterval);
            return;
          }

          if (current.status === 'redeemed') {
            overlayCancelled.style.display = 'none';
            overlayRedeemed.style.display = 'flex';
            overlayExpired.style.display = 'none';
            timerDisplay.style.display = 'none';
            clearInterval(CanteenState.ticketTimerInterval);
            return;
          }

          const expiry = new Date(current.expiryTime);
          const remainingMs = expiry - new Date();

          if (remainingMs <= 0) {
            const limitDisplay = document.getElementById('ticket-limit-display');
            if (limitDisplay) {
              limitDisplay.innerText = CanteenState.accountDetails.ticketExpiryHours || 5;
            }
            overlayExpired.style.display = 'flex';
            overlayRedeemed.style.display = 'none';
            overlayCancelled.style.display = 'none';
            timerDisplay.style.display = 'none';
            clearInterval(CanteenState.ticketTimerInterval);
            return;
          }

          // Show countdown
          timerDisplay.style.display = 'flex';
          overlayExpired.style.display = 'none';
          overlayRedeemed.style.display = 'none';
          overlayCancelled.style.display = 'none';

          const hours = Math.floor(remainingMs / 3600000);
          const minutes = Math.floor((remainingMs % 3600000) / 60000);
          const seconds = Math.floor((remainingMs % 60000) / 1000);
          document.getElementById('ticket-timer-counter').innerText = 
            [hours, minutes, seconds].map(v => v.toString().padStart(2, '0')).join(':');
        }
      }
    } catch (e) {
      console.warn("Failed to check ticket status:", e);
    }
  };

  tick();
  CanteenState.ticketTimerInterval = setInterval(tick, 1000); // Check status every 1 second
}

async function renderTicketBarcode(booking) {
  const canvas = document.getElementById('ticket-barcode-canvas');
  if (!canvas) return;

  const barcodeValue = booking.id;

  try {
    await loadExternalScript('https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js');
    if (!canvas.isConnected || AppRouter.currentTab !== 'ticket') return;
    JsBarcode(canvas, barcodeValue, {
      format: 'CODE128',
      lineColor: '#1b4d3e',
      background: '#ffffff',
      width: 1,
      height: 96,
      displayValue: false,
      margin: 8
    });
  } catch (e) {
    console.error("Failed to render ticket barcode:", e);
  }
}

// --- TICKET RETRIEVAL FINDER ---
document.getElementById('retrieval-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const feedback = document.getElementById('retrieval-feedback');
  const resultsContainer = document.getElementById('retrieval-results');
  const panel = document.getElementById('retrieval-results-panel');
  const showFeedback = message => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.style.display = 'block';
  };
  if (CanteenState.retrievedTicketsTimerInterval) {
    clearInterval(CanteenState.retrievedTicketsTimerInterval);
    CanteenState.retrievedTicketsTimerInterval = null;
  }

  if (submitButton) submitButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  showFeedback('Searching for your bills. This can take a few seconds.');
  if (panel) panel.style.display = 'none';
  resultsContainer.replaceChildren();

  const name = document.getElementById('cust-retrieval-name').value.trim();
  const passkey = document.getElementById('cust-retrieval-passkey').value.trim();

  try {
    const res = await fetch('/api/bookings/retrieve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: name, passkey })
    });

    if (res.ok) {
      const allTickets = await res.json();
      const currentTime = Date.now();
      CanteenState.retrievedTickets = allTickets.filter(ticket =>
        ticket.status === 'pending' && new Date(ticket.expiryTime).getTime() > currentTime
      );

      if (panel) panel.style.display = 'block';

      if (CanteenState.retrievedTickets.length === 0) {
        resultsContainer.innerHTML = `<p style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem 0;">No pending bills found.</p>`;
        showFeedback('No pending bills found for that checkout name or phone number and PIN.');
        return;
      }

      CanteenState.retrievedTickets.forEach(t => {
        const div = document.createElement('div');
        div.className = 'ticket-item-row';
        div.dataset.bookingId = t.id;
        div.style.padding = '0.75rem 0';
        div.style.borderBottom = '1px dashed var(--border-dark)';
        
        div.innerHTML = `
          <div>
            <div style="font-weight: 600; font-size: 0.85rem; word-break: break-all;">${t.id.substring(0, 15)}...</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Total: ₹${t.totalAmount} | ${new Date(t.bookingTime).toLocaleDateString()}</div>
          </div>
          <div style="text-align: right; display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-end;">
            <span class="retrieved-ticket-status"><span class="badge badge-warning">Pending</span></span>
            <button class="btn-sm btn-sm-accent" onclick="loadRetrievedTicket('${t.id}')" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; margin-top: 0.25rem;">View Bill</button>
          </div>
        `;
        resultsContainer.appendChild(div);
      });
      showFeedback(`${CanteenState.retrievedTickets.length} pending bill${CanteenState.retrievedTickets.length === 1 ? '' : 's'} found. Status refreshes automatically.`);
      startRetrievedBillTracking();
    } else {
      const errorData = await res.json().catch(() => ({}));
      if (res.status === 404) {
        showFeedback(errorData.error || 'No bills found for this checkout name or phone and pass key.');
      } else if (res.status === 400) {
        showFeedback(errorData.error || 'Enter your checkout name or phone and 4-digit pass key.');
      } else {
        showFeedback(errorData.error || 'Unable to search tickets right now. Please try again.');
      }
    }
  } catch (err) {
    console.error(err);
    showFeedback('Unable to connect to the ticket service. Please try again.');
  } finally {
    form.removeAttribute('aria-busy');
    if (submitButton) submitButton.disabled = false;
  }
});

function startRetrievedBillTracking() {
  if (CanteenState.retrievedTicketsTimerInterval) {
    clearInterval(CanteenState.retrievedTicketsTimerInterval);
  }

  const poll = async () => {
    if (CanteenState.retrievedTicketsPollInProgress ||
        !document.getElementById('ticket-retrieval-gate').classList.contains('active')) {
      return;
    }

    const pendingTickets = CanteenState.retrievedTickets.filter(ticket => ticket.status === 'pending');
    if (pendingTickets.length === 0) {
      clearInterval(CanteenState.retrievedTicketsTimerInterval);
      CanteenState.retrievedTicketsTimerInterval = null;
      return;
    }

    CanteenState.retrievedTicketsPollInProgress = true;
    try {
      const updates = await Promise.all(pendingTickets.map(async ticket => {
        const response = await fetch(`/api/bookings/status/${encodeURIComponent(ticket.id)}`);
        if (!response.ok) {
          throw new Error(`Bill status request failed (${response.status}).`);
        }
        return { ticket, status: await response.json() };
      }));

      const resultsContainer = document.getElementById('retrieval-results');
      updates.forEach(({ ticket, status }) => {
        ticket.redeemedTime = status.redeemedTime;
        const row = Array.from(resultsContainer.querySelectorAll('.ticket-item-row'))
          .find(element => element.dataset.bookingId === ticket.id);
        const displayStatus = status.status === 'pending' &&
          new Date(status.expiryTime).getTime() <= Date.now()
          ? 'expired'
          : status.status;
        ticket.status = displayStatus;
        if (displayStatus !== 'pending' && row) row.remove();
      });

      CanteenState.retrievedTickets = CanteenState.retrievedTickets.filter(ticket => ticket.status === 'pending');
      if (!CanteenState.retrievedTickets.some(ticket => ticket.status === 'pending')) {
        clearInterval(CanteenState.retrievedTicketsTimerInterval);
        CanteenState.retrievedTicketsTimerInterval = null;
        const feedback = document.getElementById('retrieval-feedback');
        if (resultsContainer) {
          resultsContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem 0;">No pending bills found.</p>';
        }
        if (feedback) feedback.textContent = 'No pending bills remain.';
      } else {
        const pendingCount = CanteenState.retrievedTickets.filter(ticket => ticket.status === 'pending').length;
        const feedback = document.getElementById('retrieval-feedback');
        if (feedback) {
          feedback.textContent = `Tracking ${pendingCount} pending bill${pendingCount === 1 ? '' : 's'}.`;
        }
      }
    } catch (error) {
      console.warn('Failed to update bill tracking statuses:', error);
      const feedback = document.getElementById('retrieval-feedback');
      if (feedback) feedback.textContent = 'Could not refresh bill statuses. Retrying shortly.';
    } finally {
      CanteenState.retrievedTicketsPollInProgress = false;
    }
  };

  CanteenState.retrievedTicketsTimerInterval = setInterval(poll, 10000);
  poll();
}

window.loadRetrievedTicket = function(bookingId) {
  const ticket = CanteenState.retrievedTickets ? CanteenState.retrievedTickets.find(x => x.id === bookingId) : null;
  if (ticket) {
    CanteenState.activeBooking = ticket;
    AppRouter.navigateTo('ticket');
    AppRouter.closeTicketRetrievalGate();
  } else {
    alert("Ticket details not found. Please try search again.");
  }
};

async function processRazorpayCheckout(bookingData, keyId) {
  try {
    // 1. Tell backend to create Razorpay Order
    const orderRes = await fetch('/api/payments/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: bookingData.totalAmount,
        bookingData
      })
    });

    if (!orderRes.ok) {
      const errData = await orderRes.json();
      await cancelPaymentGateway(false);
      alert(`Razorpay Order creation failed: ${errData.error || 'Check server keys'}`);
      return;
    }

    const rzpOrder = await orderRes.json();

    // 2. Open Razorpay payment modal
    const options = {
      "key": keyId,
      "amount": rzpOrder.amount, // In paise
      "currency": "INR",
      "name": "N Cafe",
      "description": "Misty Hills Kitchen Services",
      "image": "assets/masala_dosa.png",
      "order_id": rzpOrder.id,
      "handler": async function (response) {
        // Payment approved! Verify on backend
        const verifyRes = await fetch('/api/payments/verify-signature', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            bookingData: bookingData
          })
        });

        if (verifyRes.ok) {
          if (checkoutTimerInterval) {
            clearInterval(checkoutTimerInterval);
            checkoutTimerInterval = null;
          }

          CanteenState.cart = [];
          CanteenState.currentLockId = null;
          CanteenState.saveCart();

          const ticketHours = CanteenState.accountDetails.ticketExpiryHours || 5;
          CanteenState.activeBooking = {
            ...bookingData,
            bookingTime: new Date().toISOString(),
            expiryTime: new Date(Date.now() + ticketHours * 3600 * 1000).toISOString(),
            status: 'pending'
          };

          AppRouter.navigateTo('ticket');
        } else {
          const errData = await verifyRes.json();
          alert(`Verification failed: ${errData.error || 'Unconfirmed transaction'}`);
        }
      },
      "modal": {
        "ondismiss": function() {
          // User closed checkout: release lock and return to cart
          if (checkoutTimerInterval) {
            clearInterval(checkoutTimerInterval);
            checkoutTimerInterval = null;
          }
          fetch('/api/locks/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lockId: bookingData.lockId })
          });
          alert("Payment dismissed. Portions released back to menu.");
        }
      },
      "prefill": {
        "name": bookingData.customerName,
        "contact": bookingData.customerPhone
      },
      "theme": {
        "color": "#1b4d3e"
      }
    };

    const rzpInstance = new Razorpay(options);
    rzpInstance.open();

  } catch (err) {
    console.error("Razorpay initiation failed:", err);
    alert("Communications failure. Payment Gateway is unavailable.");
  }
}

// --- INITIAL EVENT BINDINGS ---
document.addEventListener('DOMContentLoaded', () => {
  CanteenState.init();

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const view = e.currentTarget.dataset.view;
      if (!view) return;
      if (view === 'cart') {
        toggleCartDrawer(true);
      } else {
        AppRouter.navigateTo(view);
      }
    });
  });

  const cartClose = document.getElementById('cart-close');
  if (cartClose) {
    cartClose.onclick = () => toggleCartDrawer(false);
  }

  const cartBackdrop = document.getElementById('cart-backdrop');
  if (cartBackdrop) {
    cartBackdrop.onclick = () => toggleCartDrawer(false);
  }

  const checkOutBtn = document.getElementById('cart-checkout-btn');
  if (checkOutBtn) {
    checkOutBtn.onclick = () => openCheckoutSummary();
  }

  // Categories Filter
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const cat = e.currentTarget.dataset.category;
      const searchVal = document.getElementById('search-food').value;
      renderFoodMenu(cat, searchVal);
    });
  });

  // Search input
  const searchInput = document.getElementById('search-food');
  if (searchInput) {
    searchInput.oninput = (e) => {
      const catBtn = document.querySelector('.cat-btn.active');
      const cat = catBtn ? catBtn.dataset.category : 'all';
      renderFoodMenu(cat, e.target.value);
    };
  }
});
