// Shows a longer-wait message if the splash stays up. External 'self' script
// so it runs under the splash CSP (inline scripts are blocked).
setTimeout(function () {
  var label = document.querySelector('.loading-label');
  if (label) {
    label.textContent = 'Still loading - this is taking longer than usual...';
  }
}, 15000);
