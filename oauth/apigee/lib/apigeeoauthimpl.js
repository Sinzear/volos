/****************************************************************************
 The MIT License (MIT)

 Copyright (c) 2013 Apigee Corporation

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/
'use strict';

/*
 * This module implements the runtime SPI by talking to a proxy that is hosted inside Apigee.
 *
 * options:
 *   uri: The URI that your Apigee DNA Adapter is deployed to Apigee
 *   key: The API key for your adapter
 */

var url = require('url');
var qs = require('querystring');
var http = require('http');
var https = require('https');
var querystring = require('querystring');
var OAuthCommon = require('volos-oauth-common');
var apigee = require('apigee-access');
var debug = require('debug')('apigee');
var semver = require('semver');
var superagent = require('superagent');
var util = require('util');
var _ = require('underscore');

var OAuthImpl = function(spi, hasApigeeAccess) {
  if (!(this instanceof OAuthImpl)) {
    throw new Error('Do not run directly.');
  }

  this.hasApigeeAccess = hasApigeeAccess;
  this.options = spi.options;
  if (hasApigeeAccess) {
    this.apigee = apigee.getOAuth();
  } else {
    this.uri = spi.uri;
    this.key = spi.key;
  }
};
module.exports.OAuthImpl = OAuthImpl;

/*
 * Generate an access token using client_credentials. Options:
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *   attributes: hash of custom attributes to store and retrieve with token
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
OAuthImpl.prototype.createTokenClientCredentials = function(options, cb) {
  var r = _.pick(options,
    'clientId', 'clientSecret', 'attributes', 'scope'
  );
  r.grantType = 'client_credentials';
  if (options.tokenLifetime) {
    r.expiresIn = options.tokenLifetime;
  }

  createCredentials(this, r, options, cb);
};

/*
 * Generate an access token using password credentials. Options:
 *   clientId: required
 *   clientSecret: required
 *   scope: optional
 *   tokenLifetime: lifetime in milliseconds, optional
 *   username: required but not checked (must be checked outside this module)
 *   password: required by not checked (must be checked outside this module)
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
OAuthImpl.prototype.createTokenPasswordCredentials = function(options, cb) {
  var r = _.pick(options,
    'username', 'password', 'clientId', 'clientSecret', 'attributes', 'scope'
  );
  r.grantType = 'password';
  if (options.tokenLifetime) {
    r.expiresIn = options.tokenLifetime;
  }

  createCredentials(this, r, options, cb);
};

/*
 * Generate an access token for authorization code once a code has been set up. Options:
 *   clientId: required
 *   clientSecret: required
 *   code: Authorization code already generated by the "generateAuthorizationCode" method
 *   redirectUri: The same redirect URI that was set in the call to generate the authorization code
 *   tokenLifetime: lifetime in milliseconds, optional
 *
 * Returns an object with all the fields in the standard OAuth 2.0 response.
 */
OAuthImpl.prototype.createTokenAuthorizationCode = function(options, cb) {
  var r = _.pick(options,
    'clientId', 'clientSecret', 'code', 'redirectUri', 'attributes'
  );
  r.grantType = 'authorization_code';
  if (options.tokenLifetime) {
    r.expiresIn = options.tokenLifetime;
  }

  createCredentials(this, r, options, cb);
};

/*
 * Generate a redirect response for the authorization_code grant type. Options:
 *   clientId: required
 *   redirectUri: required and must match what was deployed along with the app
 *   scope: optional
 *   state: optional but certainly recommended
 *
 * Returns the redirect URI as a string.
 */
OAuthImpl.prototype.generateAuthorizationCode = function(options, cb) {
  var r = _.pick(options,
    'clientId', 'redirectUri', 'scope', 'state'
  );
  r.responseType = 'code';
  debug('generateAuthorizationCode: %j', r);

  var self = this;
  if (self.hasApigeeAccess) {
    self.apigee.generateAuthorizationCode(r, function(err, resp) {
      if (err) {
        cb(err);
      } else {
        checkResultError(resp, function(err, response) {
          if (err) {
            cb(err);
          } else {
            cb(undefined, makeLocationHeader(r.redirectUri, response));
          }
        });
      }
    });
  } else {
    superagent.agent().
      post(self.uri + '/v2/oauth/generateAuthorizationCode').
      set('x-DNA-Api-Key', self.key).
      type('json').
      send(r).
      end(function(err, resp) {
        if (err) {
          cb(err);
        } else {
          debug('generate result: %j', resp.body);
          checkResultError(resp.body, function(err, response) {
            if (err) {
              cb(err);
            } else {
              cb(undefined, makeLocationHeader(r.redirectUri, response));
            }
          });
        }
      });
  }
};

function makeLocationHeader(redirectUri, resp) {
  var location = url.parse(redirectUri ? redirectUri : 'http://');
  location.query = _.pick(resp,
    'code', 'state', 'scope', 'error', 'error_description'
  );
  var hdr = url.format(location);
  debug('Location header: %s', hdr);
  return hdr;
}

/*
 * Generate a redirect response for the implicit grant type. Options:
 *   clientId: required
 *   redirectUri: required and must match what was deployed along with the app
 *   scope: optional
 *   state: optional but certainly recommended
 *
 * Returns the redirect URI as a string.
 */
OAuthImpl.prototype.createTokenImplicitGrant = function(options, cb) {
  var r = _.pick(options,
    'clientId', 'attributes', 'redirectUri', 'scope', 'state'
  );
  r.grantType ='implicit_grant';
  r.responseType = 'token';
  if (options.tokenLifetime) {
    r.expiresIn = options.tokenLifetime;
  }

  var self = this;
  if (self.hasApigeeAccess) {
    self.apigee.generateAccessToken(r, function(err, resp) {
      if (err) {
        cb(err);
      } else {
        checkResultError(resp, function(err, response) {
        if (err) {
          cb(err);
        } else {
          cb(undefined, makeImplicitLocationHeader(r.redirectUri, response));
        }
      });
    }
    });
  } else {
    superagent.agent().
      post(self.uri + '/v2/oauth/generateAccessToken').
      set('x-DNA-Api-Key', self.key).
      type('json').
      send(r).
      end(function(err, resp) {
        if (err) {
          cb(err);
        } else {
          checkResultError(resp.body, function(err, response) {
            if (err) {
              cb(err);
            } else {
              cb(undefined, makeImplicitLocationHeader(r.redirectUri, response));
            }
          });
        }
      });
  }
};

function makeImplicitLocationHeader(redirectUri, resp) {
  var location = url.parse(redirectUri);
  var hash = _.pick(resp,
    'access_token', 'token_type', 'expires_in', 'scope', 'state',
    'error', 'error_description'
  );

  location.hash = qs.stringify(hash);
  var hdr = url.format(location);
  debug('Location header: %s', hdr);
  return hdr;
}

/*
 * Refresh an existing access token, and return a new token. Options:
 *   clientId: required
 *   clientSecret: required
 *   refreshToken: required, from the original token grant
 *   scope: optional
 *   tokenLifetime: optional, time in milliseconds for the new token to live
 */
OAuthImpl.prototype.refreshToken = function(options, cb) {
  var r = _.pick(options,
    'refreshToken', 'clientId', 'clientSecret', 'scope'
  );
  r.grantType = 'refresh_token';
  if (options.tokenLifetime) {
    r.expiresIn = options.tokenLifetime;
  }

  createCredentials(this, r, options, function(err, result) {
    // todo: fix at source (spec p. 45)
    if (err && /^.*Invalid Scope/.test(err.error_description)) {
      err.error = err.errorCode = 'invalid_scope';
    }
    cb(err, result);
  });
};

/*
 * Invalidate an existing token. Parameters:
 *   clientId: required
 *   clientSecret: required
 *   refreshToken: either this or accessToken must be specified
 *   accessToken: same
 */
OAuthImpl.prototype.invalidateToken = function(options, cb) {
  var r = _.pick(options,
    'token', 'clientId', 'clientSecret', 'tokenTypeHint'
  );
  debug('invalidateToken request: %j', r);

  var self = this;
  if (self.hasApigeeAccess) {
    self.apigee.revokeToken(r, function(err, data) {
      if (err) {
        cb(err);
      } else {
        if (data) {
          checkResultError(data, cb);
        } else {
          cb(undefined, {});
        }
      }
    });
  } else {
    superagent.agent().
      post(self.uri + '/v2/oauth/revokeToken').
      set('x-DNA-Api-Key', self.key).
      type('json').
      send(r).
      end(function(err, resp) {
        if (err) {
          debug('invalidate error: %s', err);
          cb(err);
        } else {
          debug('Invalidate response: %s', resp.text);
          checkResultError(resp.body, cb);
        }
      });
  }
};

/*
 * Validate an access token.
 */
OAuthImpl.prototype.verifyToken = function(token, requiredScopes, cb) {
  var r = {
    token: token
  };
  if (requiredScopes) {
    r.scope = requiredScopes;
  }
  if (Array.isArray(r.scope) && r.scope.length === 0) { // workaround a bug in Edge w/ empty arrays
    delete(r.scope);
  }
  debug('verifyToken request: %j', r);

  var self = this;
  if (self.hasApigeeAccess) {
    self.apigee.verifyAccessToken(undefined, r, function(err, data) {
      if (err) {
        // Need to fix the error code because Apigee doesn't set it right
        err.errorCode = 'invalid_token';
        cb(err);
      } else {
        checkResultError(data, function(err, result) {
          if (err) {
            err.errorCode = 'invalid_token';
          }
          cb(err, result);
        });
      }
    });
  } else {
    superagent.agent().
      post(self.uri + '/v2/oauth/verifyAccessToken').
      set('x-DNA-Api-Key', self.key).
      type('json').
      send(r).
      end(function(err, resp) {
        if (err) {
          debug('Verify error: %s', err);
          // Need to fix the error code because Apigee doesn't set it right
          err.errorCode = 'invalid_token';
          cb(err);
        } else {
          debug('Verify response: %j', resp.body);
          checkResultError(resp.body, function(err, result) {
            if (err) {
              err.errorCode = 'invalid_token';
            }
            cb(err, result);
          });
        }
      });
  }
};

/*
 * Validate an access token.
 */
OAuthImpl.prototype.verifyApiKey = function(apiKey, request, cb) {
  var r = {
    apiKey: apiKey
  };
  debug('verifyApiKey request: %j', r);

  var self = this;
  if (self.hasApigeeAccess) {
    self.apigee.verifyApiKey(undefined, r, function(err, data) {
      if (err) {
        cb(err);
      } else {
        checkResultError(data, function(err, result) {
          cb(err, result);
        });
      }
    });
  } else {
    superagent.agent().
      post(self.uri + '/v2/oauth/verifyApiKey').
      set('x-DNA-Api-Key', self.key).
      type('json').
      send(r).
      end(function(err, resp) {
        if (err) {
          cb(err);
        } else {
          debug('Verify response: %j', resp.body);
          checkResultError(resp.body, function(err, result) {
            cb(err, result);
          });
        }
      });
  }
};

function createCredentials(self, request, options, cb) {
  if (self.hasApigeeAccess) {
    debug('Local generateAccessToken %s', request.grantType);
    self.apigee.generateAccessToken(request, function(err, result) {
      if (err) {
        cb(err);
      } else {
        checkResultError(result, cb);
      }
    });
  } else {
    debug('Remote generateAccessToken %j', request);
    superagent.agent().
      post(self.uri + '/v2/oauth/generateAccessToken').
      set('x-DNA-Api-Key', self.key).
      type('json').
      send(request).
      end(function(err, resp) {
        if (err) {
          debug('createCredentials error: %s', err);
          cb(err);
        } else {
          debug('Create credentials response: %j', resp.body);
          checkResultError(resp.body, cb);
        }
      });
  }
}

function checkResultError(result, cb) {
  if (result.error) {
    if (/Invalid Authorization Code/.test(result.error_description) ||
        /Required param.+redirect_uri/.test(result.error_description) ||
        /Invalid redirect_uri/.test(result.error_description)) {
      debug('Replacing error code %s with invalid_grant', result.error);
      result.error = 'invalid_grant';
    }
    result.errorCode = result.error;
    cb(result);
  } else {
    cb(undefined, result);
  }
}
