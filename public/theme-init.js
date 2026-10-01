// Applies the persisted theme before the stylesheet loads to avoid a
// flash of the wrong theme. Loaded as an external 'self' script so it runs
// under the page CSP (script-src 'self'); an inline script would be blocked.
(function () {
  try {
    var pref = localStorage.getItem('rosi-theme');
    var theme = pref;
    if (!theme || theme === 'system') {
      theme =
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    } else if (theme !== 'light' && theme !== 'dark' && theme !== 'purple') {
      theme = 'dark';
    }
    document.documentElement.dataset.theme = theme;

    var flatUi = localStorage.getItem('rosi-flat-ui');
    if (flatUi === 'true') {
      document.documentElement.dataset.flatUi = 'true';
    }
  } catch (e) {}
})();
