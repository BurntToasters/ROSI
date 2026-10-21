// Licenses view (loaded in an iframe from the main window). External script
// so it runs under the app CSP; the main window owns window.api.
(function () {
  'use strict';

  function openExternal(url) {
    try {
      if (window.parent && window.parent.api && window.parent.api.openExternal) {
        window.parent.api.openExternal(url);
      }
    } catch (_) {
      /* cross-origin or unavailable parent */
    }
  }

  function isSafeUrl(value) {
    if (typeof value !== 'string') return false;
    var trimmed = value.trim();
    if (!trimmed) return false;
    try {
      var url = new URL(trimmed);
      return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
    } catch (_) {
      return false;
    }
  }

  function wireStaticLinks() {
    var links = document.querySelectorAll('a[data-external]');
    for (var i = 0; i < links.length; i += 1) {
      links[i].addEventListener('click', function (event) {
        event.preventDefault();
        var url = event.currentTarget.getAttribute('data-external');
        if (isSafeUrl(url)) openExternal(url);
      });
    }
  }

  function makeLink(label, url) {
    if (!isSafeUrl(url)) return null;
    var link = document.createElement('a');
    link.className = 'npm-link';
    link.href = '#';
    link.textContent = label;
    link.addEventListener('click', function (event) {
      event.preventDefault();
      openExternal(url);
    });
    return link;
  }

  function repositoryUrl(entry) {
    if (typeof entry.repository === 'string') return entry.repository;
    if (entry.repository && typeof entry.repository.url === 'string') {
      return entry.repository.url;
    }
    return null;
  }

  function showError(container, label, error) {
    container.textContent = '';
    var errorP = document.createElement('p');
    errorP.className = 'npm-error';
    errorP.textContent = 'Failed to load ' + label + ': ' + (error && error.message ? error.message : String(error));
    container.appendChild(errorP);
  }

  function renderPackageGroups(container, licenses, displayName) {
    var groups = {};
    var names = Object.keys(licenses);
    for (var i = 0; i < names.length; i += 1) {
      var info = licenses[names[i]];
      var type = info.licenses || 'Unknown';
      if (!groups[type]) groups[type] = [];
      groups[type].push({ name: displayName(names[i]), info: info });
    }
    container.textContent = '';
    var totalP = document.createElement('p');
    totalP.className = 'npm-total';
    totalP.append('Total packages: ');
    var totalStrong = document.createElement('strong');
    totalStrong.textContent = String(names.length);
    totalP.appendChild(totalStrong);
    container.appendChild(totalP);

    var types = Object.keys(groups).sort();
    for (var t = 0; t < types.length; t += 1) {
      var packages = groups[types[t]].sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
      var details = document.createElement('details');
      details.className = 'npm-license-group';
      var summary = document.createElement('summary');
      summary.className = 'npm-license-summary';
      summary.textContent =
        types[t] + ' (' + packages.length + ' package' + (packages.length !== 1 ? 's' : '') + ')';
      details.appendChild(summary);
      var list = document.createElement('div');
      list.className = 'npm-license-list';
      for (var p = 0; p < packages.length; p += 1) {
        var card = document.createElement('div');
        card.className = 'npm-package-card';
        var nameDiv = document.createElement('div');
        nameDiv.className = 'npm-package-name';
        nameDiv.textContent = packages[p].name;
        card.appendChild(nameDiv);
        var repoLink = makeLink('Repository', repositoryUrl(packages[p].info));
        if (repoLink) {
          var linksDiv = document.createElement('div');
          linksDiv.className = 'npm-links';
          linksDiv.appendChild(repoLink);
          card.appendChild(linksDiv);
        }
        if (typeof packages[p].info.licenseText === 'string' && packages[p].info.licenseText) {
          var textDetails = document.createElement('details');
          var textSummary = document.createElement('summary');
          textSummary.textContent = 'Show license text';
          var pre = document.createElement('pre');
          pre.className = 'license-scroll';
          pre.textContent = packages[p].info.licenseText;
          textDetails.appendChild(textSummary);
          textDetails.appendChild(pre);
          card.appendChild(textDetails);
        }
        list.appendChild(card);
      }
      details.appendChild(list);
      container.appendChild(details);
    }
  }

  function loadJson(file) {
    return fetch(file).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function loadPackageLicenses(containerId, file, label, displayName) {
    var container = document.getElementById(containerId);
    if (!container) return;
    loadJson(file)
      .then(function (licenses) {
        renderPackageGroups(container, licenses, displayName);
      })
      .catch(function (error) {
        showError(container, label, error);
      });
  }

  function loadBundledNotices() {
    var container = document.getElementById('bundled-licenses-container');
    if (!container) return;
    loadJson('bundled-licenses.json')
      .then(function (notices) {
        return Promise.all(
          notices.map(function (notice) {
            return fetch(notice.file)
              .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.text();
              })
              .then(function (text) {
                return { label: notice.label, text: text };
              });
          })
        );
      })
      .then(function (entries) {
        container.textContent = '';
        for (var i = 0; i < entries.length; i += 1) {
          var details = document.createElement('details');
          var summary = document.createElement('summary');
          summary.textContent = entries[i].label;
          var pre = document.createElement('pre');
          pre.className = 'license-scroll';
          pre.textContent = entries[i].text;
          details.appendChild(summary);
          details.appendChild(pre);
          container.appendChild(details);
        }
      })
      .catch(function (error) {
        showError(container, 'bundled binary notices', error);
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    wireStaticLinks();
    loadBundledNotices();
    loadPackageLicenses('cargo-licenses-container', 'licenses-cargo.json', 'Rust crate licenses', function (key) {
      return key.replace(/^cargo:/, '');
    });
    loadPackageLicenses('npm-licenses-container', 'licenses.json', 'npm licenses', function (key) {
      return key;
    });
  });
})();
