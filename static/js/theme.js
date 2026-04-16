/* ═══════════════════════════════════════════════
   DAA Theme Management — Responsive Dark Mode
   ═══════════════════════════════════════════════ */

const ThemeManager = {
  storageKey: 'daa-theme-pref',
  toggleSelector: '#checkbox',

  init() {
    const toggle = document.querySelector(this.toggleSelector);
    if (!toggle) return;

    // 1. Check for saved theme preference
    const currentTheme = localStorage.getItem(this.storageKey) || 'light';
    
    // 2. Apply theme
    this.applyTheme(currentTheme);
    toggle.checked = (currentTheme === 'dark');

    // 3. Listen for changes
    toggle.addEventListener('change', (e) => {
      const newTheme = e.target.checked ? 'dark' : 'light';
      this.applyTheme(newTheme);
      this.saveTheme(newTheme);
      
      // Notify other scripts (like charts)
      window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: newTheme } }));
    });
  },

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  },

  saveTheme(theme) {
    localStorage.setItem(this.storageKey, theme);
  },

  getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }
};

// Initialize as soon as DOM is ready
document.addEventListener('DOMContentLoaded', () => ThemeManager.init());

window.getCurrentTheme = () => ThemeManager.getCurrentTheme();
