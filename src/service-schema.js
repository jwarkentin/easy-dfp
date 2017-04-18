let traverse = require('traverse')
let dfpHelpers = require('./dfp-helpers')

/**
 * The main purpose of this schema manager is to re-order the keys in objects so they are sent in the same order as they appear in the
 * schema for DFP. Unfortunately, DFP is very sensitive to the order fields appear in.
 */
class ServiceSchema {
  constructor(serviceName, client) {
    this.serviceName = serviceName
    this.client = client
    this.attrKey = client.wsdl.options.attributesKey
    this.interface = {}
    this.types = {}
    this.fields = new Map()
    this._definitions = client.wsdl.definitions
    this._schema = this._definitions.schemas[Object.keys(this._definitions.schemas)[0]]
    this._complexTypes = this._schema.complexTypes
    this._simpleTypes = this._schema.types

    Object.entries(this._definitions.portTypes[`${serviceName}Interface`].methods).forEach(([methodName, methodDef]) => {
      this.interface[methodName] = this.getFields(methodDef.input)
    })

    this._fixWsdlRecursion()
  }

  _fixWsdlRecursion() {
    let wsdlProto = this.client.wsdl.constructor.prototype
    wsdlProto.findChildSchemaObject = function(obj, childName) {
      let found = null
      traverse(obj).forEach(function(el) {
        if (el && el.$name === childName) {
          found = el
          this.stop()
        }
      })
      let result = found

      return result
    }
  }

  mapCall(call, input) {
    if (typeof input === 'string') {
      input = dfpHelpers.query(input)
    }

    let result
    try {
      result = this.rewriteObject(input, this.interface[call], [])
    } catch(e) {
      if (e instanceof SchemaError) {
        throw new ServiceInputError(this.serviceName, call, e.path, e.message)
      } else {
        throw e
      }
    }

    return result
  }

  parseType(type) {
    if (!type) return

    let parts = type.match(/(?:(\w+)\:)?([^:]+)/)
    return {
      prefix: parts[1],
      type: parts[2]
    }
  }

  getType(type, prefix) {
    if (!this.types[type]) {
      let self = this
      let typeParts = this.parseType(type)
      let complexType = this._complexTypes[type]
      let simpleType = this._simpleTypes[type]

      if (complexType) {
        let typeDef = {}
        Object.entries(complexType).forEach(([key, value]) => {
          if (key[0] === '$') {
            if (value === 'true') {
              value = true
            } else if (value === 'false') {
              value = false
            }
            typeDef[key.slice(1)] = value
          }
        })
        typeDef.fields = this.getFields(complexType)

        this.types[type] = typeDef
      } else if (simpleType) {
        let typeDef = {
          isSimple: true
        }
        Object.entries(simpleType).forEach((key, value) => {
          if (key[0] === '$') {
            typeDef[key.slice(1)] = value
          }
        })

        traverse(simpleType).forEach(function(el) {
          if (el.name === 'restriction') {
            if (!el.$base) {
              throw new Error(`Missing 'base' attribute for <restriction> element of <SimpleType name="${type}">`)
            }

            let baseParts = self.parseType(el.$base)
            Object.assign(typeDef, {
              baseType: baseParts.type,
              basePrefix: baseParts.prefix,
              enum: el.children.filter(x => x.name === 'enumeration').map(x => x.$value)
            })
            this.stop()
          }
        })

        this.types[type] = typeDef
      } else if (prefix === 'xsd') {
        let jsTypeName = type[0].toUpperCase() + type.substr(1).toLowerCase()
        let typeDef = {
          xsdType: type,
          isSimple: true,
          isPrimitive: true
        }

        if (global[jsTypeName] instanceof Function) {
          typeDef.primitiveType = jsTypeName
          typeDef.primitiveCtor = global[jsTypeName]
        }

        this.types[type] = typeDef
      }
    }

    return this.types[type]
  }

  getFields(element) {
    if (!this.fields.has(element)) {
      let self = this
      let fields = {}
      traverse(element).forEach(function(el) {
        if (el.name === 'extension') {
          let baseParts = self.parseType(el.$base)
          Object.assign(fields, self.getType(baseParts.type, baseParts.prefix).fields)
        } else if (el.name === 'sequence') {
          el.children.forEach(el => {
            let typeParts = self.parseType(el.$type)
            fields[el.$name] = {
              type: typeParts.type,
              typePrefix: typeParts.prefix,
              isArray: el.$maxOccurs === 'unbounded'
            }
          })

          this.stop()
        }
      })
      this.fields.set(element, fields)
    }

    return this.fields.get(element)
  }

  rewriteObject(obj, fields, path) {
    if (typeof obj !== 'object') {
      throw new SchemaError(path, `Unexpected type [${typeof obj}]. Expecting [object].`)
    }

    // `fields` should be an object of key->value pairs where each key matches a name that may be found in the input object and each
    // value is a definition describing what the input value for that field should look like.
    //
    // Field values may or may not be arrays. The field definition tracks `isArray` to determine whether we should be looking for one.
    //
    // Field value types fall into one of the following categories:
    //   1. Primitive (xsd) type such as 'xsd:string'
    //   2. Simple type that resolves to a primitive type, such as an enum
    //      Example: Type 'tns:CustomCriteriaSet.LogicalOperator' is enum of 'xsd:string'
    //   3. Complex type (tns) such as 'tns:LineItem'
    //
    // In type #1 we simply want to assign the input field value directly to the output.
    // In type #2 we want to first verify that the input value is allowed by the enum and then assign it directly as with #1.
    // In type #3 we need to grab the complex field type definition and recursively call the rewriter function with the input field's
    // value and the sub-type definition object of expected/possible key->value pairs for the complex type.

    let specialAttrs = obj[this.attrKey]
    let newObj = specialAttrs ? { [this.attrKey]: specialAttrs } : {}
    for (let [field, fieldDef] of Object.entries(fields)) {
      let val = obj[field]
      if (val !== undefined) {
        let fieldPath = [ ...path, field ]
        let typeDef = this.getType(fieldDef.type, fieldDef.typePrefix)
        if (!typeDef) {
          // This should only apply to types defined and referenced in the schema. If this error is thrown it means there's a
          // typo or other problem causing a missing type definition in the WSDL itself.
          throw new SchemaError(fieldPath, `Could not find definition for type [${fieldDef.type}]. This is a problem with the WSDL.`)
        }

        let valIsArray = Array.isArray(val)
        let vals = valIsArray ? val : [ val ]
        if (fieldDef.isArray && !valIsArray) {
          throw new SchemaError(fieldPath, `Expecting an array`)
        } else if (valIsArray && !fieldDef.isArray) {
          throw new SchemaError(fieldPath, `Not expecting an array`)
        }

        let mappedVals = vals.map((value, index) => {
          let valuePath = fieldDef.isArray ? [ ...fieldPath, index ] : fieldPath
          let concreteTypeDef = typeDef

          // If the field definition is abstract we need to look at the type specified in the actual input to pull the concrete type field definition
          if (typeDef.abstract && !value._type) {
            throw new SchemaError(valuePath, `Field takes an abstract type. You must specify a specific type using the '_type' property.`)
          }

          if (value._type) {
            concreteTypeDef = this.getType(value._type)
            if (!concreteTypeDef) {
              let abstractMsg = typeDef.abstract ? ` (should inherit from abstract type [${fieldDef.type}])` : ''
              throw new SchemaError(valuePath, `Could not find definition for field type [${value._type}]${abstractMsg}. Do you have a typo?`)
            }
            value[this.attrKey] = Object.assign(value[this.attrKey] || {}, { 'xsi:type': value._type })
          }

          if (concreteTypeDef.enum && concreteTypeDef.enum.indexOf(value) === -1) {
            throw new SchemaError(valuePath, `Unrecognized value '${value}'`)
          }

          return concreteTypeDef.isSimple
                  ? value
                  : this.rewriteObject(value, concreteTypeDef.fields, valuePath)
        })

        newObj[field] = valIsArray ? mappedVals : mappedVals[0]
      }
    }

    // Look for extra/unrecognized fields that don't belong
    let ignoreFields = [ '_type', this.attrKey ]
    for (let field in obj) {
      if (fields[field] === undefined && ignoreFields.indexOf(field) === -1) {
        throw new SchemaError([ ...path, field ], `Unrecognized field name '${field}'. Do you have a typo?`)
      }
    }

    return newObj
  }
}

function SchemaError(path, message) {
  this.path = path
  this.message = message
}

function ServiceInputError(serviceName, serviceCall, path, message) {
  if (!Array.isArray(path)) {
    throw new Error(`'path' is required to create a SchemaError`)
  }

  let pathStr = path.join('.').replace(/(?:\.|\]|^)(\d+)(?:\.|$)??/g, '[$1]')
  this.name = 'Service Input Error'
  this.message = `[Service Input Error] [PATH: ${pathStr}] Invalid input for ${serviceName}::${serviceCall}(): ${message}`
}


module.exports = {
  default: ServiceSchema,
  errors: {
    SchemaError,
    ServiceInputError
  }
}
