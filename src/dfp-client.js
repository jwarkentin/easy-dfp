let _ = { merge: require('lodash/merge') }
let fs = require('fs')
let google = require('googleapis')
let DFPService = require('./dfp-service')

function DFPClient(options) {
  this.options = _.merge({
    auth: {
      authType: 'jwt'   // Options are: 'jwt', 'file', 'client'
    },
    logRequest: false,
    logResponse: false,
    immutable: false
  }, options)

  let { apiVersion } = this.options
  if (apiVersion) {
    if (apiVersion[0] !== 'v') {
      this.options.apiVersion = `v${apiVersion}`
    }
  } else {
    throw new Error(`You must specify a DFP API version for the DFP client to work`)
  }

  this.dfpAuthClient = this.getAuthClient()
  this.authTokens = {}
  this.services = {}
  this.lastRequestXML = ''
  this.lastResponseXML = ''

  let self = this
  return Object.create(new Proxy(this, {
    get(target, prop) {
      // Node does something really weird that we have to account for here. If you call `Object.getOwnPropertyDescriptor()`
      // on an object containing an instance of this proxy, the given `prop` will not be a string but will instead return
      // `Symbol(util.inspect.custom)`. This just ignores Node's custom inspection stuff so property descriptors work.
      if (typeof prop !== 'string' || prop === 'inspect') {
        return
      }

      if (prop in target) {
        return target[prop]
      }

      if (!self.services[prop]) {
        if (/Service$/.test(prop)) {
          self.services[prop] = new DFPService(prop, self.options, self.dfpAuthClient)
        } else {
          throw new Error(`Invalid service name '${prop}'. Do you have a typo?`)
        }
      }

      return self.services[prop]
    }
  }))
}

Object.assign(DFPClient.prototype, {
  getAuthClient() {
    let opts = this.options.auth

    if (opts.authType === 'file') {
      let keyData = JSON.parse(fs.readFileSync(opts.file).toString('utf-8'))
      opts.authType = 'jwt'
      opts.clientEmail = keyData.client_email
      opts.privateKey = keyData.private_key
    }

    if (opts.authType === 'client') {
      if (opts.client) {
        // This covers all use cases not currently accounted for. Can be an actual `googleapis` lib AuthClient or a custom function.
        // Technically just needs to be an object with an `authorize([callback(err, tokens)])` method that can give an object of the form:
        // {
        //   token_type     : e.g. 'Bearer'
        //   access_token   : Self-explanatory
        //   refresh_token  : Self-explanatory
        //   expiry_date    : Milliseconds since unix epoch until `access_token` expires
        // }
        return opts.client
      } else {
        throw new Error(`Missing 'client' option for authType = 'client'`)
      }
    } else if (opts.authType === 'jwt') {
      return new google.auth.JWT(opts.clientEmail, null, opts.privateKey, [ 'https://www.googleapis.com/auth/dfp' ])
    }

    throw new Error(`Missing or invalid authType`)
  },

  changeNetwork(networkCode, propertyCode) {
    this.services = {}
    this.dfpUser.networkCode = networkCode
    this.dfpUser.applicationName = propertyCode
  }
})


module.exports = DFPClient