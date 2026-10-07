const fs = require('fs')
const { execSync } = require('child_process')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-vectornav-vnins',
    name: 'VectorNav $VNINS parser',
    description: 'Reads VectorNav $VNINS from a serial port and publishes heading, attitude, position, SOG/COG'
  }
  let stream = null, buf = '', last = 0

  plugin.schema = {
    type: 'object',
    properties: {
      device: { type: 'string', title: 'Serial device', default: '/dev/serial/by-id/usb-FTDI_USB-RS232_Cable_AU04Q2FP-if00-port0' },
      baud: { type: 'number', title: 'Baud rate', default: 115200 },
      rateHz: { type: 'number', title: 'Max publish rate (Hz)', default: 10 }
    }
  }

  const rad = d => d * Math.PI / 180

  function checksumOk (line) {
    const m = line.match(/^\$(.*)\*([0-9A-Fa-f]{2})$/)
    if (!m) return false
    let c = 0
    for (const ch of m[1]) c ^= ch.charCodeAt(0)
    return c === parseInt(m[2], 16)
  }

  function parse (line) {
    if (!line.startsWith('$VNINS') || !checksumOk(line)) return null
    const f = line.split('*')[0].split(',')
    if (f.length < 16) return null
    const mode = parseInt(f[3], 16) & 0x3 // 0 none, 1 aligning, 2 tracking, 3 GNSS lost
    const yaw = +f[4], pitch = +f[5], roll = +f[6]
    const lat = +f[7], lon = +f[8], alt = +f[9]
    const vN = +f[10], vE = +f[11]
    const values = [
      { path: 'navigation.headingTrue', value: rad((yaw + 360) % 360) },
      { path: 'navigation.attitude', value: { roll: rad(roll), pitch: rad(pitch), yaw: rad(yaw) } },
      { path: 'navigation.vectornav.insMode', value: mode }
    ]
    if (lat !== 0 || lon !== 0) {
      values.push({ path: 'navigation.position', value: { latitude: lat, longitude: lon, altitude: alt } })
    }
    if (mode === 2 || mode === 3) {
      values.push({ path: 'navigation.speedOverGround', value: Math.hypot(vN, vE) })
      values.push({ path: 'navigation.courseOverGroundTrue', value: (Math.atan2(vE, vN) + 2 * Math.PI) % (2 * Math.PI) })
    }
    return values
  }

  plugin.start = function (options) {
    const o = Object.assign({ device: plugin.schema.properties.device.default, baud: 115200, rateHz: 10 }, options)
    try {
      execSync(`stty -F ${o.device} ${o.baud} raw -echo`)
    } catch (e) {
      app.setPluginError('stty failed: ' + e.message)
      return
    }
    stream = fs.createReadStream(o.device, { encoding: 'ascii' })
    stream.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        const now = Date.now()
        if (now - last < 1000 / o.rateHz) continue
        const values = parse(line)
        if (values) {
          last = now
          app.handleMessage(plugin.id, { updates: [{ values }] })
        }
      }
      if (buf.length > 4096) buf = ''
    })
    stream.on('error', e => app.setPluginError(e.message))
    app.setPluginStatus('Reading ' + o.device + ' @ ' + o.baud)
  }

  plugin.stop = function () {
    if (stream) { stream.destroy(); stream = null }
    buf = ''
  }

  return plugin
}
