import { mount } from 'svelte'
import './app.css'
// Keeps `data-theme` in step with the chosen appearance once the bundle runs.
import './lib/theme.svelte.js'
// Powers Flowbite's interactive components (dropdowns, modals, tooltips, ...).
// Elements rendered after the initial mount need an explicit `initFlowbite()`.
import 'flowbite'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app
