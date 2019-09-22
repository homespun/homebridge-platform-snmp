/* jshint asi: true, esversion: 6, node: true, laxbreak: true, laxcomma: true, undef: true, unused: true */

const NodeCache   = require('node-cache')
    , arp         = require('arp-a')
//  , debug       = require('debug')('homebridge-platform-snmp')
    , discovery   = require('homespun-discovery').observers.snmp
    , sensorTypes = require('homespun-discovery').utilities.sensortypes
    , snmpn       = require('snmp-native')
    , underscore  = require('underscore')
    , util        = require('util')


let Accessory
  , Service
  , Characteristic
  , CommunityTypes
  , UUIDGen

module.exports = function (homebridge) {
  Accessory      = homebridge.platformAccessory
  Service        = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  CommunityTypes = require('hap-nodejs-community-types')(homebridge)
  UUIDGen        = homebridge.hap.uuid

  homebridge.registerPlatform('homebridge-platform-snmp', 'SNMP', SNMP, true)
}


const SNMP = function (log, config, api) {
  if (!(this instanceof SNMP)) return new SNMP(log, config, api)

  this.log = log
  this.config = config || { platform: 'SNMP' }
  this.api = api

  this.options = underscore.defaults(this.config.options || {}, { verboseP: false })

  this.agents = {}
  this.discoveries = {}

  discovery.init()
  if (api) this.api.on('didFinishLaunching', this._didFinishLaunching.bind(this))
  else this._didFinishLaunching()
}

SNMP.prototype._didFinishLaunching = function () {
  const self = this

  self.observer = new discovery.Observe({ sysObjectIDs: underscore.keys(sysObjectIDs) })
  self.observer.on('error', function (err) {
    self.log.error('discovery', err)
  }).on('up', function (options, service) {
    const agentId     = service.host + ':' + service.port
        , sysObjectID = service.packet && service.packet.pdu && service.packet.pdu.varbinds
                          && service.packet.pdu.varbinds[1] && service.packet.pdu.varbinds[1].value

    if (!self.agents[agentId]) {
      if (!sysObjectIDs[sysObjectID]) return self.log.error('unknown sysObjectID: ' + sysObjectID)

      self.agents[agentId] = { agent: new (sysObjectIDs[sysObjectID])(self, agentId, service) }
    }
    self.agents[agentId].timestamp = underscore.now()
  })

  setTimeout(function () {
    underscore.keys(self.discoveries).forEach(function (uuid) {
      const accessory = self.discoveries[uuid]

      self.log.warn('accessory not (yet) discovered', { UUID: uuid })
      accessory.updateReachability(false)
    })
  }.bind(self), 5 * 1000)

  self.log('didFinishLaunching')
}

SNMP.prototype._addAccessory = function (agent) {
  const self = this

  const accessory = new Accessory(agent.name, agent.uuid)

  accessory.on('identify', function (paired, callback) {
    self.log(accessory.displayName, ': identify request')
    callback()
  })

  agent.attachAccessory.bind(agent)(accessory)

  if (!self.discoveries[accessory.UUID]) {
    self.api.registerPlatformAccessories('homebridge-platform-snmp', 'SNMP', [ accessory ])
    self.log('addAccessory', underscore.pick(agent, [ 'uuid', 'name', 'manufacturer', 'model', 'serialNumber' ]))
  }
}

SNMP.prototype.configurationRequestHandler = function (context, request, callback) {/* jshint unused: false */
  this.log('configuration request', { context: context, request: request })
}

SNMP.prototype.configureAccessory = function (accessory) {
  const self = this

  accessory.on('identify', function (paired, callback) {
    self.log(accessory.displayName, ': identify request')
    callback()
  })

  self.discoveries[accessory.UUID] = accessory
  self.log('configureAccessory', underscore.pick(accessory, [ 'UUID', 'displayName' ]))
}

const Agent = function (platform, agentId, service) {
  const varbinds = service.packet && service.packet.pdu && service.packet.pdu.varbinds

  if (!(this instanceof Agent)) return new Agent(platform, agentId, service)

  this.platform = platform
  this.agentId = agentId
  this.rinfo = underscore.pick(service, [ 'host', 'port' ])
  this.varbinds = varbinds

  this.model = varbinds[0].value
  this.name = varbinds[2].value

  this.cache = new NodeCache({ stdTTL: this.platform.config.ttl || 10 })

// TBD: set timeouts
  this.session = new snmpn.Session(this.rinfo)
}

Agent.prototype.attachAccessory = function (accessory) {
  this.accessory = accessory
  this._setServices(accessory)
  this.platform.log('attachAccessory', underscore.pick(this, [ 'uuid', 'name', 'manufacturer', 'model', 'serialNumber' ]))
}

// not used
Agent.prototype.onlineP = function (callback) {
  const self = this

  const agent = self.platform.agents[self.agentId]
  const oidI = discovery.Observe.prototype.oidI

// TBD: set range via options
  if ((agent.timestamp + (5 * 1000)) >= underscore.now) return callback(null, true)

  /* sysUptime.0 */
  self.session.get({ oid: oidI('1.3.6.1.2.1.1.3.0') }, function (err, varbinds) {
    if (err) {
      self.platform.log.error('onlineP', underscore.extend({ agentId: self.agentId }, err))
      return callback((err.toString() !== 'Error: Timeout')  ? err : null, false)
    }

    self.platform.log('agent ' + self.agentId + ' sysUpTime: ' + varbinds[0].value)
    self.agents[self.agentId].timestamp = underscore.now()
    callback(null, true)
  })
}


const ServersCheck = function (platform, agentId, service) {
  const self = this

  if (!(self instanceof ServersCheck)) return new ServersCheck(platform, agentId, service)

  Agent.call(self, platform, agentId, service)
  self.manufacturer = 'ServersCheck'

  self._refresh(function (err, properties) {
    let accessory

    if (err) return self.platform.log.error('refresh', underscore.extend({ agentId: self.agentId }, err))

    self.cache.set('properties', properties)
    if (self.accessory) return

    accessory = self.platform.discoveries[self.uuid]
    if (!accessory) return self.platform._addAccessory(self)

    delete self.platform.discoveries[self.uuid]
    self.attachAccessory(accessory)
    accessory.updateReachability(true)
  })
}
util.inherits(ServersCheck, Agent)

ServersCheck.prototype._setServices = function (accessory) {
  const self = this

  const findOrCreateService = function (P, callback) {
    let newP, service

    service = accessory.getService(P)
    if (!service) {
      newP = true
      service = new P()
    }
    callback(service)

    if (newP) accessory.addService(service, self.name)
  }

  findOrCreateService(Service.AccessoryInformation, function (service) {
    service.setCharacteristic(Characteristic.Name, self.name)
           .setCharacteristic(Characteristic.Manufacturer, self.manufacturer)
           .setCharacteristic(Characteristic.Model, self.model)
           .setCharacteristic(Characteristic.SerialNumber, self.serialNumber)
  })

  underscore.keys(self.capabilities).forEach(function (key) {
    const f =
    { airflow:
        function () {
          findOrCreateService(CommunityTypes.AirFlowSensor, function (service) {
            service.setCharacteristic(Characteristic.Name, self.name + ' Air Flow')
            service.getCharacteristic(CommunityTypes.AirFlow)
                   .on('get', function (callback) { self._getState.bind(self)('airflow', callback) })
           })
         }

     , noise:
        function () {
          findOrCreateService(CommunityTypes.NoiseLevelSensor, function (service) {
            service.setCharacteristic(Characteristic.Name, self.name + ' Noise Level')
            service.getCharacteristic(CommunityTypes.NoiseLevel)
                   .on('get', function (callback) { self._getState.bind(self)('noise', callback) })
           })
         }

     , 'particles.2_5':
        function () {
          findOrCreateService(Service.AirQualitySensor, function (service) {
            service.setCharacteristic(Characteristic.Name, self.name + ' Air Quality')
            service.getCharacteristic(Characteristic.AirQuality)
                   .on('get', function (callback) { self._getState.bind(self)('aqi', callback) })
            service.getCharacteristic(Characteristic.PM2_5Density)
                   .on('get', function (callback) { self._getState.bind(self)('particles.2_5', callback) })
          })
        }

    , temperature:
        function () {
          findOrCreateService(Service.TemperatureSensor, function (service) {
            service.setCharacteristic(Characteristic.Name, self.name + ' Temperature')
            service.getCharacteristic(Characteristic.CurrentTemperature)
                   .on('get', function (callback) { self._getState.bind(self)('temperature', callback) })
          })
        }
    }[key] || function () { self.platform.log.warn('setServices: no Service for ' + key) }
    f()
  })
}

ServersCheck.prototype._refresh = function (callback) {
  const self = this

  const oidI = discovery.Observe.prototype.oidI
  let oid

  if (!self.uuid) {
    arp.table(function (err, entry) {
      if (err) return self.platform.logger.error('ARP table', err)

      if (!entry) {
        if (!self.uuid) self.uuid = UUIDGen.generate(self.name)
        return
      }

      if ((self.uuid) || (entry.ip !== self.rinfo.host)) return

      self.uuid = UUIDGen.generate(entry.mac + ':' + self.rinfo.port)
      if (!self.serialNumber) self.serialNumber = entry.mac
    })
  }

  oid = self.varbinds[1].value + '.3'
  self.session.getSubtree({ oid: oidI(oid) }, function (err, varbinds) {
    let name, properties

    if (err) {
      self.platform.log.error('getSubtree', underscore.extend({ agentId: self.agentId, oid: oid }, err))
      return callback(err)
    }

    self.timestamp = underscore.now()

    name = '-'
    properties = {}
    varbinds.forEach(function (varbind) {
      const leaf = varbind.oid[varbind.oid.length - 2]

      if ((leaf % 4) === 1) name = varbind.value
      else if ((leaf % 4) === 2) underscore.extend(properties, self._normalize(name, varbind.value))
    })

    oid = self.varbinds[1].value + '.11'
    self.session.getSubtree({ oid: oidI(oid) }, function (err, varbinds) {
      let names

      if (err) {
        self.platform.log.error('getSubtree', underscore.extend({ agentId: self.agentId, oid: oid }, err))
        return callback(err)
      }

      self.timestamp = underscore.now()

      names = {}
      varbinds.forEach(function (varbind) {
        const leaf    = varbind.oid[varbind.oid.length - 2]
          , subtree = varbind.oid[varbind.oid.length - 3]

        if (leaf === 1) names[subtree] = varbind.value
        else if ((leaf === 2) && (!!names[subtree])) {
          underscore.extend(properties, self._normalize(names[subtree], varbind.value))
        }
      })

      self.capabilities = {}
      underscore.keys(properties).forEach(function (key) { self.capabilities[key] = sensorTypes[key] })
      callback(null, properties)
    })
  })
}

/*
  name:       Int. Temp/Ext. Temp | Airflow | Sound Meter | Humidity      | Water Detect    | Dust Sensor
              temperature         | airflow | noise       | humidity      | liquid_detected | particles.2_5
  units:      'C'                 | m/s     | dB          | RH-%  * 100   | boolean         | mg/m3
  datapoints: '26.51'             | '0.01'  | '48.93'     | '36.82' / 100 | 'DRY'           | '0.01'

not yet:
PowerFail (power failure)
Shock (vibration/shock)
Security (door contact/ security probe)
Flooding (leak/flooding)
UndefinedIO (dry contact and I/O probe)
*/
ServersCheck.prototype._normalize = function (name, value) {
    let f, key

    key = { Airflow        : 'airflow'
          , 'Dust Sensor'  : 'particles.2_5'
          , 'Ext. Temp'    : 'temperature'
          , Humidity       : 'humidity'
          , 'Int. Temp'    : 'temperature'
          , 'Sound Meter'  : 'noise'
          , 'Water Detect' : 'liquid_detect'
          }[name]
    if (!key) return

    f = { airflow         : function () { return parseFloat(value)         }
        , humidity        : function () { return (parseFloat(value) / 100) }
        , liquid_detect   : function () { return (value !== 'DRY')         }
        , noise           : function () { return parseFloat(value)         }
        , 'particles.2_5' : function () { return parseFloat(value)         }
        , temperature     : function () { return parseFloat(value)         }
        }[key]
    if (!f) return

    return underscore.object([ key ], [ f() ])
}

ServersCheck.prototype._getState = function (property, callback) {
  const self = this

  self.cache.get('properties', function (err, properties) {
    const f = function (properties, cacheP) {
      if (!properties) {
        self.platform.log.error('getState: no properties', underscore.extend({ agentId: self.agentId, cacheP: cacheP }, err))
        return
      }

      if (property === 'aqi') {
        const fpc = properties['particles.2_5']
// TBD: set range via options
        return (fpc < 35 ? Characteristic.AirQuality.EXCELLENT : fpc < 100 ? Characteristic.AirQuality.FAIR
                         : Characteristic.AirQuality.POOR)
      }
      return properties[property]
    }

    if (err) return callback(err)

    if (properties) return callback(null, f(properties, true))

    self._refresh(function (err, properties) {
      if (err) return callback(err)

      if (properties) self.cache.set('properties', properties)

      callback(null, f(properties, false))
    })
  })
}


/*
const UPS = function (platform, agentId, service) {
  const self = this

  if (!(self instanceof UPS)) return new UPS(platform, agentId, service)

  Agent.call(self, platform, agentId, service)
  self.manufacturer = 'Schneider Electric'

  console.log(JSON.stringify(service, null, 2))

  process.exit(0)
}
util.inherits(UPS, Agent)

UPS.prototype._setServices = function (accessory) {
}

UPS.prototype._refresh = function (callback) {
}

UPS.prototype._normalize = function (name, value) {
}

UPS.prototype._getState = function (property, callback) {
}
*/

/*
getName                upsIdentName
getManufacturer        upsIdentManufacturer
getModel               upsIdentModel
getSerialNumber        battManIdentSerialNumber
getFirmwareRevision    upsIdentUPSSoftwareVersion

power:
getInputVoltageAC      upsConfigInputVoltage
getBatteryVoltageDC    upsBatteryVoltage
getUPSLoadPercdent     upsEstimatedChargeRemaining
getVolts               upsBatteryVoltage
getVoltAmperes         upsConfigOutputVA 
getWatts               upsInputTruePower
getKilowattHours       
getOutputVoltageAC     OUTPUTV
getVoltAmperes         OUTCURNT
getCurrentTemperature  upsBatteryTemperature

battery:
getContactSensorState  (STATFLAG & 0x08) ? CONTACT_DETECTED : CONTACT_NOT_DETECTED
getStatusActive        LOADPCT > 0 ? ACTIVE : INACTIVE
getStatusFault         faultP ? GENERAL_FAULT: NO_FAULT
getEveTimesOpened
getEveOpenDuration
getEveCloseDuration
getEveLastActivation
getEveResetTotal
getBatteryLevel        BCHARGE
getChargingState       (STATFLAG & 0x80) ? NOT_CHARGEABLE ? ((flags & 0x10) || (BCHARGE === 100) ? NOT_CHARGING : CHARGING
getStatusLowBattery    (STATFLAG & 0x40) ? BATTERY_LEVEL_LOW : BATTERY_LEVEL_NORMAL
 */


const sysObjectIDs =
{ '1.3.6.1.4.1.17095'      : ServersCheck
/*
 , '1.3.6.1.4.1.318.1.3.27' : UPS
 */
}
