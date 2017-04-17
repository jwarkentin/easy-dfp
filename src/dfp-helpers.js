let moment = require('moment-timezone')

module.exports = {
  getDfpDate(timezone = 'UTC') {
    return this.toDfpDate(new Date(), timezone)
  },

  getDfpDateTime(timezone = 'UTC') {
    return this.toDfpDateTime(new Date(), timezone)
  },

  toDfpDate(d, timezone = 'UTC') {
    let date = moment(d).tz(timezone)

    return {
      year: date.get('year'),
      month: date.get('month') + 1,
      day: date.get('date')
    }
  },

  toDfpDateTime(dt, timezone = 'UTC') {
    let date = moment(dt).tz(timezone)

    return {
      date: this.toDfpDate(date, timezone),
      hour: date.get('hours'),
      minute: date.get('minutes'),
      second: date.get('seconds'),
      timeZoneID: timezone
    }
  },

  fromDfpDate(d) {
    return moment.utc([ d.year, d.month - 1, d.day ])
  },

  fromDfpDateTime(dt, timezone = 'UTC') {
    return moment.tz([ dt.date.year, dt.date.month - 1, dt.date.day, dt.hour, dt.minute, dt.second ], dt.timeZoneID).tz(timezone)
  },

  query(str, stmntField = 'filterStatement') {
    return {
      [stmntField]: { query: str }
    }
  }
}