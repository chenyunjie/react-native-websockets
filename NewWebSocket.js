/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @providesModule NewWebSocket
 * @flow
 */

const {DeviceEventEmitter, NativeEventEmitter, NativeModules, NetInfo} = require('react-native');
const EventTarget = require('event-target-shim');
const NewWebSocketEvent = require('./NewWebSocketEvent');


/* $FlowFixMe(>=0.54.0 site=react_native_oss) This comment suppresses an error
 * found when Flow v0.54 was deployed. To see the error delete this comment and
 * run Flow. */
const invariant = require('fbjs/lib/invariant');

const {WebSocketModule} = NativeModules;

import type EventSubscription from 'EventSubscription';


const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const CLOSE_NORMAL = 1000;

const WEBSOCKET_EVENTS = [
  'close',
  'error',
  'message',
  'open',
];

let nextWebSocketId = 0;


/**
 * Browser-compatible WebSockets implementation.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
 * See https://github.com/websockets/ws
 * 
 * 从React Native 自带的websocket模块修改，添加了网络监听功能，删除连接错误时调用close方法，交给外部进行控制，不做策略操作
 */
class NewWebSocket extends EventTarget(...WEBSOCKET_EVENTS) {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  CONNECTING: number = CONNECTING;
  OPEN: number = OPEN;
  CLOSING: number = CLOSING;
  CLOSED: number = CLOSED;

  _socketId: number;
  _eventEmitter: NativeEventEmitter;
  _networkEventEmitter: NativeEventEmitter;
  _subscriptions: Array<EventSubscription>;
  _binaryType: ?BinaryType;
  _lastConnectionType: ?string;

  onclose: ?Function;
  onerror: ?Function;
  onmessage: ?Function;
  onopen: ?Function;

  bufferedAmount: number;
  extension: ?string;
  protocol: ?string;
  readyState: number = CONNECTING;
  url: ?string;

  // This module depends on the native `WebSocketModule` module. If you don't include it,
  // `WebSocket.isAvailable` will return `false`, and WebSocket constructor will throw an error

  static isAvailable: boolean = !!WebSocketModule;

  constructor(url: string, protocols: ?string | ?Array<string>, options: ?{headers?: {origin?: string}}) {
    super();
    
    if (typeof protocols === 'string') {
      protocols = [protocols];
    }

    const {headers = {}, ...unrecognized} = options || {};

    // Preserve deprecated backwards compatibility for the 'origin' option
    if (unrecognized && typeof unrecognized.origin === 'string') {
      console.warn('Specifying `origin` as a WebSocket connection option is deprecated. Include it under `headers` instead.');
      /* $FlowFixMe(>=0.54.0 site=react_native_fb,react_native_oss) This
       * comment suppresses an error found when Flow v0.54 was deployed. To see
       * the error delete this comment and run Flow. */
      headers.origin = unrecognized.origin;
      /* $FlowFixMe(>=0.54.0 site=react_native_fb,react_native_oss) This
       * comment suppresses an error found when Flow v0.54 was deployed. To see
       * the error delete this comment and run Flow. */
      delete unrecognized.origin;
    }

    // Warn about and discard anything else
    if (Object.keys(unrecognized).length > 0) {
      console.warn('Unrecognized WebSocket connection option(s) `' + Object.keys(unrecognized).join('`, `') + '`. '
        + 'Did you mean to put these under `headers`?');
    }

    if (!Array.isArray(protocols)) {
      protocols = null;
    }

    if (!NewWebSocket.isAvailable) {
      throw new Error('Cannot initialize WebSocket module. ' +
      'Native module WebSocketModule is missing.');
    }

    this._eventEmitter = new NativeEventEmitter(WebSocketModule);
    this._socketId = nextWebSocketId++;
    this._registerEvents();

    
    //添加网络监听
    this._networkEventEmitter = new NativeEventEmitter(NetInfo);
    this._handlerNetworkChanged = this._handlerNetworkChanged.bind(this);
    this._networkEventEmitter.addListener(
      'networkStatusDidChange',
      this._handlerNetworkChanged
    );
    WebSocketModule.connect(url, protocols, { headers }, this._socketId);
  }

  //网络变化时关闭当前连接，交给外部进行重连操作
  _handlerNetworkChanged(connectionInfo) {
    //code-1001-离开非活动状态,直接重置为失败
    this._eventEmitter.emit('websocketFailed', {id: this._socketId});
    this._networkEventEmitter.removeListener(
      'networkStatusDidChange',
      this._handlerNetworkChanged
    );
  }
  
  close(code?: number, reason?: string): void {

    if (this.readyState === this.CLOSING ||
        this.readyState === this.CLOSED) {
      return;
    }

    this.readyState = this.CLOSING;
    this._close(code, reason);
  }

  send(data: string): void {
    if (this.readyState === this.CONNECTING) {
      throw new Error('INVALID_STATE_ERR');
    }

    WebSocketModule.send(data, this._socketId);
  }

  ping(): void {
    if (this.readyState === this.CONNECTING) {
        throw new Error('INVALID_STATE_ERR');
    }

    WebSocketModule.ping(this._socketId);
  }

  _close(code?: number, reason?: string): void {
      // See https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
      const statusCode = typeof code === 'number' ? code : CLOSE_NORMAL;
      const closeReason = typeof reason === 'string' ? reason : '';
      WebSocketModule.close(statusCode, closeReason, this._socketId);
  }

  _unregisterEvents(): void {
    this._subscriptions.forEach(e => e.remove());
    this._subscriptions = [];
  }

  _registerEvents(): void {
    this._subscriptions = [
      this._eventEmitter.addListener('websocketMessage', ev => {
        if (ev.id !== this._socketId) {
          return;
        }
        if (this.onmessage) {
          this.onmessage(ev.data);
        }
      }),
      this._eventEmitter.addListener('websocketOpen', ev => {
        
        if (ev.id !== this._socketId) {
          return;
        }
        this.readyState = this.OPEN;
        if (this.onopen) {
          this.onopen();
        }
      }),
      this._eventEmitter.addListener('websocketClosed', ev => {
        if (ev.id !== this._socketId) {
          return;
        }
        this.readyState = this.CLOSED;
        if (this.onclose) {
          this.onclose({message: ev.message});
        }
        this._unregisterEvents();
        this.close();
      }),
      this._eventEmitter.addListener('websocketFailed', ev => {
        if (ev.id !== this._socketId) {
          return;
        }
        
        if (this.onerror) {
          this.onerror({message: ev.message});
        }
        //删除onclose相应
        this._unregisterEvents();
        this.close({message: ev.message});
        this.readyState = this.CLOSED;
      })
    ];
  }
}

module.exports = NewWebSocket;
