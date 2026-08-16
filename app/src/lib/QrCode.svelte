<script>
  import qr from 'qrcode-generator'

  /**
   * A QR code, drawn here rather than fetched.
   *
   * The thing being encoded is a shared secret. An image built by the server is
   * an image *of* that secret, travelling as its own request and landing in
   * whatever the browser and any proxy in between keep. Drawn from the URI the
   * page already holds, it never becomes a resource at all.
   *
   * SVG rather than a canvas: it scales to whatever the layout gives it, prints
   * legibly, and needs no measuring on mount.
   */
  let { value, size = 200, label = 'Scan this with your authenticator app' } = $props()

  /**
   * The modules to fill, as one SVG path.
   *
   * One path rather than a rect per module: a version-4 code is several hundred
   * dark modules, and that many elements is a lot of DOM for a picture of a
   * square. Error correction at `M` — the code sits on a screen a phone is
   * pointed at, not on something that will be creased or printed badly.
   */
  const drawn = $derived.by(() => {
    const code = qr(0, 'M')
    code.addData(value)
    code.make()
    const count = code.getModuleCount()
    let path = ''
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`
      }
    }
    return { path, count }
  })
</script>

<!-- A quiet zone of four modules on every side, which is what the specification
     asks for and what a scanner needs to find the edges against a dark page. -->
<svg
  data-qr
  role="img"
  aria-label={label}
  width={size}
  height={size}
  viewBox="-4 -4 {drawn.count + 8} {drawn.count + 8}"
  class="rounded-lg bg-white p-0"
>
  <rect x="-4" y="-4" width={drawn.count + 8} height={drawn.count + 8} fill="#fff" />
  <path d={drawn.path} fill="#000" />
</svg>
