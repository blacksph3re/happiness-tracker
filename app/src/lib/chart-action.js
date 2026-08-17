import * as echarts from 'echarts'

/** Mount an ECharts instance and keep it fed, disposing it on teardown. */
export function chart(node, options) {
  const instance = echarts.init(node, null, { renderer: 'canvas' })
  instance.setOption(options)
  // Stashed on the node itself, the same way a `data-*` attribute would be:
  // a seam for the e2e suite to read what was actually drawn, since a canvas
  // otherwise has no DOM a test can inspect. Named to say so.
  node.__chartForTests = instance
  const resize = () => instance.resize()
  window.addEventListener('resize', resize)
  return {
    update(next) {
      instance.setOption(next, { notMerge: true })
    },
    destroy() {
      window.removeEventListener('resize', resize)
      instance.dispose()
    },
  }
}
