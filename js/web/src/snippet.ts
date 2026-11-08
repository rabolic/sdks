/**
 * The async loader for `<head>`. It defines a stub `window.rabolic` that
 * queues calls until the CDN script loads and replays them. Keep in sync with
 * `snippet/snippet.html` (a test checks they match).
 */
export const SNIPPET: string = `<script>
  !(function (w, d, src) {
    if (w.rabolic) return
    var q = (w.rabolic = [])
    var m = ['init', 'track', 'page', 'identify', 'reset', 'register', 'unregister', 'setConsent', 'optOut', 'optIn', 'flush']
    for (var i = 0; i < m.length; i++)
      (function (n) {
        q[n] = function () {
          q.push([n].concat([].slice.call(arguments)))
        }
      })(m[i])
    q.getAnonymousId = function () {
      return null
    }
    q.appLink = function (url) {
      return url
    }
    var s = d.createElement('script')
    s.async = true
    s.src = src
    d.head.appendChild(s)
  })(window, document, 'https://cdn.rabolic.com/v1/rabolic.js')

  rabolic.init({ projectKey: 'rb_pub_YOUR_KEY' })
</script>`

/** The loader with your key filled in. */
export function snippetFor(projectKey: string, src = 'https://cdn.rabolic.com/v1/rabolic.js'): string {
  return SNIPPET.replace('rb_pub_YOUR_KEY', projectKey).replace('https://cdn.rabolic.com/v1/rabolic.js', src)
}
