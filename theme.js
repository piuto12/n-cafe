(function () {
  const storageKey = 'ncafe-theme';
  const root = document.documentElement;

  function getSavedTheme() {
    try {
      return localStorage.getItem(storageKey) || 'dark';
    } catch (error) {
      console.warn('Unable to read the saved theme preference:', error);
      return 'dark';
    }
  }

  function applyTheme(theme) {
    const nextTheme = theme === 'light' ? 'light' : 'dark';
    root.dataset.theme = nextTheme;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const lightMode = nextTheme === 'light';
      button.innerHTML = lightMode
        ? '<i class="fas fa-moon"></i><span>Dark mode</span>'
        : '<i class="fas fa-sun"></i><span>Light mode</span>';
      button.setAttribute('aria-label', lightMode ? 'Switch to dark mode' : 'Switch to light mode');
      button.setAttribute('title', lightMode ? 'Switch to dark mode' : 'Switch to light mode');
    });
  }

  applyTheme(getSavedTheme());

  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextTheme = root.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(nextTheme);
      try {
        localStorage.setItem(storageKey, nextTheme);
      } catch (error) {
        console.warn('Unable to save the theme preference:', error);
      }
    });
  });
})();
