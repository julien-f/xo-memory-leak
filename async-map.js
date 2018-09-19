const map = require('lodash/map')

module.exports = function asyncMap(collection, iteratee) {
  let then
  if (collection != null && typeof (then = collection.then) === 'function') {
    return then.call(collection, collection => asyncMap(collection, iteratee))
  }

  let errorContainer
  const onError = error => {
    if (errorContainer === undefined) {
      errorContainer = { error }
    }
  }

  return Promise.all(
    map(collection, (item, key, collection) =>
      new Promise(resolve => {
        resolve(iteratee(item, key, collection))
      }).catch(onError)
    )
  ).then(values => {
    if (errorContainer !== undefined) {
      throw errorContainer.error
    }
    return values
  })
}
