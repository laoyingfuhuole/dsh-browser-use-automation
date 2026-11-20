import { HostClient } from './client.js'

export class BrowserCore {
  constructor(config = {}, client) {
    this.config = config
    this.client = client ?? new HostClient({
      width: Number.isInteger(config.width) && config.width > 0 ? config.width : 1400,
      height: Number.isInteger(config.height) && config.height > 0 ? config.height : 900,
      components: [],
    })
    this.leases = new Map()
    this.disposed = false
  }

  mount(group) {
    if (this.disposed) throw new Error('browser core is disposed')
    if (this.leases.has(group)) throw new Error(`browser component already mounted: ${group}`)
    const controller = new AbortController()
    const lease = {
      signal: controller.signal,
      call: (op, payload, signal) => {
        if (controller.signal.aborted) return Promise.reject(controller.signal.reason)
        return this.client.call(op, { ...payload, component: group }, AbortSignal.any([controller.signal, ...signal ? [signal] : []]))
      },
      dispose: () => {
        if (this.leases.get(group) !== lease) return
        controller.abort(new Error(`browser component disabled: ${group}`))
        this.leases.delete(group)
        if (!this.disposed) this.client.configureComponents([...this.leases.keys()])
      },
    }
    this.leases.set(group, lease)
    this.client.configureComponents([...this.leases.keys()])
    return lease
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const lease of this.leases.values()) lease.dispose()
    this.client.dispose()
  }
}
