import { mount } from 'svelte'

import App from './App.svelte'
import './styles.css'

const target = document.querySelector<HTMLElement>('#app')
if (!target) throw new Error('Dashboard root element is missing.')

target.replaceChildren()
mount(App, { target })
