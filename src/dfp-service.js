let soap = require('soap')
let ServiceSchema = require('./service-schema').default

function DFPService(name, clientOptions, authClient) {
  this.options = clientOptions
  this.dfpAuthClient = authClient
  this.dfpSoapClient = null
  this.serviceName = name
  this.service = null
  this._authTokens = null
  this._fetchTokens = null

  this.ready = new Promise((resolve, reject) => {
    this.getService(name).then(({ service: svcInterface, client }) => {
      this.service = svcInterface
      this.dfpSoapClient = client
      this.serviceSchema = new ServiceSchema(name, client)
      resolve(svcInterface)
    }).catch(err => {
      if (/Invalid WSDL URL/i.test(err.message) || /Code:\s*404/i.test(err.message)) {
        err = new Error(`Invalid service name '${name}': ${err.message.split('\n')[0]}`)
      }
      reject(err)
    })
  })

  let self = this
  return Object.create(new Proxy(this, {
    get(target, name) {
      if (name in target) {
        return target[name]
      }

      let returnFn = function(args, callback, options) {
        if (!args) {
          args = {}
        }

        return new Promise((resolve, reject) => {
          self.ready.then(service => {
            if (!service[name]) {
              throw new Error(`${self.serviceName} does not have a method named '${name}'`)
            }

            if (self.options.immutable && /(create|update|delete|action)/i.test(name)) {
              throw new Error(`Operation '${self.serviceName}.${name}()' is not permitted. Mutation is disabled from this instance.`)
            }

            service[name](self.serviceSchema.mapCall(name, args), (err, result) => {
              let logRequest = self.options.logRequest
              let logResponse = self.options.logResponse
              if (err && self.options.logXmlOnError) {
                logRequest = true
                logResponse = true
              }

              if (logRequest) {
                let msg = `XML of last request to ${self.serviceName}::${name}()`
                let dashes = (new Array(msg.length + 1)).join('-')
                console.log(`${msg}\n${dashes}\n${self.dfpSoapClient.lastRequest}\n`)
              }

              if (logResponse) {
                let msg = `XML of last response from ${self.serviceName}::${name}()`
                let dashes = (new Array(msg.length + 1)).join('-')
                console.log(`${msg}\n${dashes}\n${self.dfpSoapClient.lastResponse}\n`)
              }

              if (err) {
                err.lastRequestXML = self.dfpSoapClient.lastRequest
                err.lastResponseXML = self.dfpSoapClient.lastResponse
                reject(err)
              } else {
                resolve(result)
              }
            }, options)
          }).catch(reject)
        })
      }

      returnFn.getSchema = self.getOpSchema.bind(self, name)

      Object.defineProperty(returnFn, 'name', { value: name })
      return returnFn
    }
  }))
}

Object.assign(DFPService.prototype, {
  getRawService() {
    return this.ready
  },

  getTypeSchema(type) {
    let typeParts = this.serviceSchema.parseType(type)
    return this.serviceSchema.getType(typeParts.type, typeParts.prefix)
  },

  getOpSchema(op) {
    if (!this.serviceSchema.interface[op]) {
      throw new Error(`Invalid op name '${op}'. Has the service finished loading yet?`)
    }
    return this.serviceSchema.interface[op]
  },

  _getAuthTokens() {
    // The default ttl for the tokens appears to be an hour. To avoid problems caused by clock skew we'll just
    // go ahead and refresh the tokens if we're within 5 minutes of the expiry time.
    let ttl = this._authTokens ? this._authTokens.expiry_date - Date.now() : 0
    if (!this._fetchTokens || ttl < 300000) {
      this._fetchTokens = new Promise((resolve, reject) => {
        this.dfpAuthClient.authorize((err, tokens) => {
          if (err) {
            reject(err)
          } else {
            this._authTokens = tokens
            resolve(tokens)
          }
        })
      })
    }

    return this._fetchTokens
  },

  _getServiceMethod(interfacePort, method) {
    return (args, callback, options, extraHeaders) => {
      this._getAuthTokens().then(tokens => {
        extraHeaders = Object.assign({
          Authorization: `${tokens.token_type} ${tokens.access_token}`
        }, extraHeaders || {})
        interfacePort[method].call(interfacePort, args, callback, options, extraHeaders)
      }).catch(callback)
    }
  },

  getService(service) {
    return new Promise((resolve, reject) => {
      let opts = this.options
      let baseUrl = 'https://ads.google.com/apis/ads/publisher'
      let wsdlUrl = `${baseUrl}/${opts.apiVersion}/${service}?wsdl`

      let client = soap.createClient(wsdlUrl, (err, client) => {
        if (err) {
          return reject(err)
        }

        client.addSoapHeader({
          RequestHeader: {
            attributes: {
              'soapenv:actor'           : 'http://schemas.xmlsoap.org/soap/actor/next',
              'soapenv:mustUnderstand'  : 0,
              'xsi:type'                : 'ns1:SoapRequestHeader',
              'xmlns:ns1'               : `https://www.google.com/apis/ads/publisher/${opts.apiVersion}`,
              'xmlns:xsi'               : 'http://www.w3.org/2001/XMLSchema-instance',
              'xmlns:soapenv'           : 'http://schemas.xmlsoap.org/soap/envelope/'
            },
            'ns1:networkCode'     : opts.networkCode,
            'ns1:applicationName' : opts.propertyCode
          }
        })

        let serviceApi = {}
        let interfacePort = client[service][`${service}InterfacePort`]
        for (let method in interfacePort) {
          if (interfacePort.hasOwnProperty(method)) {
            if (typeof interfacePort[method] === 'function') {
              serviceApi[method] = this._getServiceMethod(interfacePort, method)
            }
          }
        }

        resolve({ service: serviceApi, client })
      })
    })
  }
})

module.exports = DFPService