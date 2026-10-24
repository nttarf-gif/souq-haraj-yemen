// Silently records that someone opened a page (city/country, device type, browser)
// via a Supabase Edge Function. Never blocks or slows down the page.
(function () {
  try {
    var endpoint = 'https://lpqbpsxqmuwijquynnps.supabase.co/functions/v1/track-visit';
    var payload = JSON.stringify({
      page: window.location.pathname,
      referrer: document.referrer || null,
    });

    if (navigator.sendBeacon) {
      var blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(endpoint, blob);
    } else {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(function () {});
    }
  } catch (e) {
    // Never let tracking break the site
  }
})();
