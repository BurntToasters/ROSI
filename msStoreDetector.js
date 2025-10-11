  (function(){
    try {
      if (window.api && window.api.getChannel) {
        const ch = window.api.getChannel();
        if (ch === 'msstore') {
          var btn = document.getElementById('checkUpdateBtn');
          if (btn) { btn.style.display = 'none'; }
        }
      }
    } catch (e) {}
  })();