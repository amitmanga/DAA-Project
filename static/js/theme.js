/* ═══════════════════════════════════════════════
   DAA Theme Management — Dark Mode Only
   ═══════════════════════════════════════════════ */

const ThemeManager = {
  init() {
    document.documentElement.setAttribute('data-theme', 'dark');
  },

  getCurrentTheme() {
    return 'dark';
  }
};

document.addEventListener('DOMContentLoaded', () => ThemeManager.init());

window.getCurrentTheme = () => 'dark';
