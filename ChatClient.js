'use strict'

var Debug = require('debug')
var network = Debug('ChatClient:network')
var protocol = Debug('ChatClient:protocol')
var api = Debug('ChatClient:api')

var Promise = require('es6-promise').Promise
var WebSocket = require('ws')

var EventEmitter = require('events').EventEmitter

var Class = require('mmclass').Class

module.exports = Class.extend(EventEmitter)({
	constructor: function ChatClient(settings) {
		if (!settings) throw new Error('settings')
		if (!settings.appId) throw new Error('settings.appId')
		if (!settings.auth) throw new Error('settings.auth')
		this._settings = {
			appId: settings.appId,
			auth: settings.auth,
			secure: settings.secure !== undefined ? !!settings.secure : true,
			keepAlive: settings.keepAlive >= 3000 ? 0|settings.keepAlive : 240 * 1000, // 4 minutes
			server: settings.server,
		}
		this._in = new EventEmitter()
		this._self = null
		this._peers = Object.create(null)

		this._in.on('presence', function (res) {
			res.sessionPeerIds.forEach(function (id) {
				if (!this._peers[id]) this._peers[id] = { presence: res.status === 'on' } // multiple client may use same session?
				else this._peers[id].presence = res.status === 'on'
			}, this)
			this.emit('presence', res)
		}.bind(this))

		this._in.on('direct', function (res) {
			var msg
			try {
				msg = JSON.parse(res.msg)
			} catch (e) {
				this.emit('error', 'Message format error' + ' -- ' + res.msg)
			}
			msg.fromPeerId = res.fromPeerId
			api('message event: ' + msg.type, msg)
			this.emit('message', msg)
			this.doCommand('ack')
		}.bind(this))

		this._in.on('ackreq', function (res) {
			protocol('ackreq?', res)
		}.bind(this))

		this._waitCommands = []
	},
	serverURL: function () {
		var server = this._settings.server
		if (server && new Date() < server.expires) return server.url
		else return null
	},
	connect: function (autoReconnect) {
		var url = this.serverURL()
		if (!url) {
			return lookupServer(this._settings).
				then(function (server) {
					this._settings.server = server
					return this.connect(autoReconnect)
				}.bind(this)).
				catch(function () {
					throw new Error('No server available')
				})
		} else {
			return new Promise(function (resolve, reject) {
				network('connect ' + url)
				var ws = new WebSocket(url)
				ws.onopen = function () {
					network('connected')
					resolve(this)
				}
				ws.onclose = function (evt) {
					network('closed', evt)
					this.emit('close', evt)
				}.bind(this)
				if (autoReconnect) ws.onerror = reconnect.bind(this)
				ws.onmessage = processMessage.bind(this)
				this._ws = ws
			}.bind(this))
		}
	},
	openSession: function (self, peers) {
		return this._settings.auth(self, peers).
			then(function (data) {
				protocol('auth', data)
				this._self = self
				data.sessionPeerIds.forEach(function (id) {
					this._peers[id] = { presence: null }
				}, this)
				return this.doCommand('session.open', {
					sessionPeerIds: data.sessionPeerIds,
					t: data.t,
					n: data.n,
					s: data.s,
				})
			}.bind(this)).
			then(function (opened) {
				protocol('session opened', opened)
				return {
					onlinePeers: opened.onlineSessionPeerIds
				}
			}).
			then(function (data) {
				protocol('presence status', data)
				data.onlinePeers.forEach(function (id) {
					this._peers[id].presence = true
				}, this)
				return data
			}.bind(this))
	},
	closeSession: function () {
		return this.doCommand('session.close')
	},
	say: function (to, text) {
		var msg = {
			type: 'text',
			content: {text: text},
			guid: Math.random().toString('36').slice(2),
			fromId: this._self,
			toId: to,
			timestamp: Date.now() / 1000 | 0,
		}
		return this.doCommand('direct', {
			msg: JSON.stringify(msg),
			toPeerIds: [].concat(to),
			transient: false,
		}).then(function () {
			return msg
		})
	},
	watch: function (peers) {
		return this._settings.auth(this._self, peers).
			then(function (data) {
				protocol('auth', data)
				data.sessionPeerIds.forEach(function (id) {
					if (!this._peers[id]) this._peers[id] = { presence: null }
					else this._peers[id].presence = null
				}, this)
				return this.doCommand('session.add', {
					sessionPeerIds: data.sessionPeerIds,
					t: data.t,
					n: data.n,
					s: data.s,
				})
			}.bind(this))
			.then(function (watched) {
				protocol('watched', watched)
				return {
					onlinePeers: watched.onlineSessionPeerIds
				}
			}).then(function (data) {
				protocol('presence status', data)
				data.onlinePeers.forEach(function (id) {
					if (!this._peers[id]) this._peers[id] = { presence: true }
					else this._peers[id].presence = true
				}, this)
				return data
			}.bind(this))
	},
	unwatch: function (peers) {
		return this.doCommand('session.remove', {
			sessionPeerIds: [].concat(peers)
		}).then(function (unwatched) {
			return {
				//todo
			}
		})
	},
	getStatus: function (peers) {
		return this.doCommand('session.query', {
			sessionPeerIds: [].concat(peers)
		})
	},
	doCommand: function (name, parameters) {
		var msg = parameters ? parameters/*todo: clone*/ : {}
		protocol('do ' + name, parameters)
		if (!msg.appId) msg.appId = this._settings.appId
		if (!msg.peerId) msg.peerId = this._self
		var cmd = Command(name)
		msg.cmd = cmd.cmd
		msg.op = cmd.op
		var s = JSON.stringify(msg)
		this._ws.send(s)
		network('send', s)
		this._keepAlive()
		if (cmd.response) return this._wait(cmd.response)
	},
	_wait: function (response) {
		return new Promise(function (resolve, reject) {
			protocol('wait ' + response)
			this._waitCommands.push([response, resolve, reject])
			//setTimeout(reconnect.bind(this, 'no heartbeat'), this._settings.heartbeatTimeout)
		}.bind(this))
	},
	ping: function () {
		this._ws.send('{}')
		this._keepAlive()
		return this._wait('pong')
	},
	_keepAlive: function () {
		clearTimeout(this._handle)
		this._handle = setTimeout(this.ping.bind(this), this._settings.keepAlive)
	}
})

function Command(name) {
	var i = name.indexOf('.')
	if (i === -1) {
		return { cmd: name, response: name === 'ack' ? undefined : 'ack' }
	}
	var cmd = name.slice(0, i), op0 = name.slice(i + 1), op1
	if (op0 === 'query') op1 = 'query-result'
	else if (op0.slice(-1) === 'e') op1 = op0 + 'd'
	else op1 = op0 + 'ed'
	var response = cmd + '.' + op1
	return { cmd: cmd, op: op0, response: response }
}

function reconnect(e) {
	network('error', e)
	//todo: reconnect
}

function processMessage(e) {
	network(e.type, e.data)
	var name, data
	if (e.data === '{}') {
		name = 'pong'
		data = {}
	} else {
		try {
			data = JSON.parse(e.data)
		} catch(e) {
			protocol('error', e.data)
			this._in.emit('error', e.data)
			return
		}
		name = data.cmd
		if (data.op) name += '.' + data.op
	}
	protocol('got ' + name, data)
	if (this._waitCommands.length > 0) {
		if (this._waitCommands[0][0] === name) {
			this._waitCommands.shift()[1](data)
		}
	}
	this._in.emit(name, data)
}


var getJSON = require('./util/getJSON')

function lookupServer(settings) {
	protocol('lookup server', settings)
	return getJSON('http://router.g0.push.avoscloud.com/v1/route?cb=?', {
		appId: settings.appId,
		secure: settings.secure ? '1' : undefined,
	}).then(function (config) {
		return {
			url: config.server,
			expires: Date.now() + config.ttl * 1000,
		}
	})
}
