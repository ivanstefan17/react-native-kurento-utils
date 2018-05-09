/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * 对 kurento-util.js 的再次封装，使其适合在 RN 中使用，并且使用
 * ES6 class module 重写之前的代码。
 */

import uuid from 'uuid'
import sdpTranslator from 'sdp-translator'
import freeice from 'freeice'
import { EventEmitter } from 'events'
import merge from 'lodash'
const inherits = require('inherits')

import {
  RTCPeerConnection,
  RTCMediaStream,
  RTCIceCandidate,
  RTCSessionDescription,
  MediaStreamTrack,
  getUserMedia,
} from 'react-native-webrtc'

const MEDIA_CONSTRAINTS = {
  audio: true,
  video: {
    mandatory: {
      minWidth: 300, // Provide your own width, height and frame rate here
      minHeight: 300,
      minFrameRate: 15
    }
  }
}

const logger = console

function noop(error) {
  if (error) logger.error(error)
}

function trackStop(track) {
  track.stop && track.stop()
}

function streamStop(stream) {
  stream.getTracks().forEach(trackStop)
}

/**
 * Returns a string representation of a SessionDescription object.
 */

function bufferizeCandidates(pc, onerror) {
  var candidatesQueue = []

  pc.addEventListener('signalingstatechange', function () {
    if (this.signalingState === 'stable') {
      while (candidatesQueue.length) {
        var entry = candidatesQueue.shift()
        pc.addIceCandidate(entry.candidate, entry.callback, entry.callback)
      }
    }
  })

  return function (candidate, callback) {
    callback = callback || onerror

    switch (pc.signalingState) {
      case 'closed':
        callback(new Error('PeerConnection object is closed'))
        break
      case 'stable':
        if (pc.remoteDescription) {
          pc.addIceCandidate(candidate, callback, callback)
          break
        }
      default:
        candidatesQueue.push({
          candidate: candidate,
          callback: callback
        })
    }
  }
}

/* Simulcast utilities */

/**
 * Wrapper object of an RTCPeerConnection. This object is aimed to simplify the
 * development of WebRTC-based applications.
 *
 * @constructor module:kurentoUtils.WebRtcPeer
 *
 * @param {String} mode Mode in which the PeerConnection will be configured.
 *  Valid values are: 'recv', 'send', and 'sendRecv'
 * @param localVideo Video tag for the local stream
 * @param remoteVideo Video tag for the remote stream
 * @param {MediaStream} videoStream Stream to be used as primary source
 *  (typically video and audio, or only video if combined with audioStream) for
 *  localVideo and to be added as stream to the RTCPeerConnection
 * @param {MediaStream} audioStream Stream to be used as second source
 *  (typically for audio) for localVideo and to be added as stream to the
 *  RTCPeerConnection
 */
function WebRtcPeer(mode, options, callback) {
  if (!(this instanceof WebRtcPeer)) {
    return new WebRtcPeer(mode, options, callback)
  }

  WebRtcPeer.super_.call(this)

  if (options instanceof Function) {
    callback = options
    options = undefined
  }

  options = options || {}
  callback = (callback || noop).bind(this)

  var self = this
  var remoteVideo = options.remoteVideo
  var videoStream = options.videoStream
  var audioStream = options.audioStream
  var mediaConstraints = options.mediaConstraints

  var connectionConstraints = options.connectionConstraints
  var pc = options.peerConnection
  var sendSource = options.sendSource || 'webcam'

  var dataChannelConfig = options.dataChannelConfig
  var useDataChannels = options.dataChannels || false
  var dataChannel

  var guid = uuid.v4()
  var configuration = merge({
    iceServers: freeice()
  },
    options.configuration)

  var onicecandidate = options.onicecandidate
  if (onicecandidate) this.on('icecandidate', onicecandidate)

  var oncandidategatheringdone = options.oncandidategatheringdone
  if (oncandidategatheringdone) {
    this.on('candidategatheringdone', oncandidategatheringdone)
  }

  var simulcast = options.simulcast
  var multistream = options.multistream
  var interop = new sdpTranslator.Interop()
  var candidatesQueueOut = []
  var candidategatheringdone = false

  var localStream = null
  var remoteStream = null

  Object.defineProperties(this, {
    'peerConnection': {
      get: function () {
        return pc
      }
    },

    'id': {
      value: options.id || guid,
      writable: false
    },

    'localStream': {
      get: function () {
        return videoStream
      }
    },


    'dataChannel': {
      get: function () {
        return dataChannel
      }
    },
  })

  // Init PeerConnection
  if (!pc) {
    console.log('创建rtc的设置:')
    console.log(configuration)
    pc = new RTCPeerConnection(configuration);
    if (useDataChannels && !dataChannel) {
      var dcId = 'WebRtcPeer-' + self.id
      var dcOptions = undefined
      if (dataChannelConfig) {
        dcId = dataChannelConfig.id || dcId
        dcOptions = dataChannelConfig.options
      }
      dataChannel = pc.createDataChannel(dcId, dcOptions);
      if (dataChannelConfig) {
        dataChannel.onopen = dataChannelConfig.onopen;
        dataChannel.onclose = dataChannelConfig.onclose;
        dataChannel.onmessage = dataChannelConfig.onmessage;
        dataChannel.onbufferedamountlow = dataChannelConfig.onbufferedamountlow;
        dataChannel.onerror = dataChannelConfig.onerror || noop;
      }
    }
  }

  pc.addEventListener('icecandidate', function (event) {
    var candidate = event.candidate

    if (EventEmitter.listenerCount(self, 'icecandidate') ||
      EventEmitter.listenerCount(
        self, 'candidategatheringdone')) {
      if (candidate) {
        var cand

        cand = candidate

        self.emit('icecandidate', cand)
        candidategatheringdone = false
      } else if (!candidategatheringdone) {
        self.emit('candidategatheringdone')
        candidategatheringdone = true
      }
    } else if (!candidategatheringdone) {
      // Not listening to 'icecandidate' or 'candidategatheringdone' events, queue
      // the candidate until one of them is listened
      candidatesQueueOut.push(candidate)

      if (!candidate) candidategatheringdone = true
    }
  })

  pc.onaddstream = options.onaddstream
  pc.onnegotiationneeded = options.onnegotiationneeded
  this.on('newListener', function (event, listener) {
    if (event === 'icecandidate' || event === 'candidategatheringdone') {
      while (candidatesQueueOut.length) {
        var candidate = candidatesQueueOut.shift()

        if (!candidate === (event === 'candidategatheringdone')) {
          listener(candidate)
        }
      }
    }
  })

  var addIceCandidate = bufferizeCandidates(pc)

  /**
   * Callback function invoked when an ICE candidate is received. Developers are
   * expected to invoke this function in order to complete the SDP negotiation.
   *
   * @function module:kurentoUtils.WebRtcPeer.prototype.addIceCandidate
   *
   * @param iceCandidate - Literal object with the ICE candidate description
   * @param callback - Called when the ICE candidate has been added.
   */
  this.addIceCandidate = function (iceCandidate, callback) {
    var candidate

    candidate = new RTCIceCandidate(iceCandidate)

    logger.debug('Remote ICE candidate received', iceCandidate)
    callback = (callback || noop).bind(this)
    addIceCandidate(candidate, callback)
  }

  this.generateOffer = function (callback) {
    callback = callback.bind(this)

    var offerAudio = true
    var offerVideo = true
    // Constraints must have both blocks
    if (mediaConstraints) {
      offerAudio = (typeof mediaConstraints.audio === 'boolean') ?
        mediaConstraints.audio : true
      offerVideo = (typeof mediaConstraints.video === 'boolean') ?
        mediaConstraints.video : true
    }

    var browserDependantConstraints = {
      offerToReceiveAudio: (mode !== 'sendonly' && offerAudio),
      offerToReceiveVideo: (mode !== 'sendonly' && offerVideo)
    }

    //FIXME: clarify possible constraints passed to createOffer()
    /*var constraints = recursive(browserDependantConstraints,
      connectionConstraints)*/

    var constraints = browserDependantConstraints;

    logger.debug('constraints: ' + JSON.stringify(constraints))

    pc.createOffer(constraints).then(function (offer) {
      logger.debug('Created SDP offer')
      offer = mangleSdpToAddSimulcast(offer)
      return pc.setLocalDescription(offer)
    }).then(function () {
      var localDescription = pc.localDescription
      logger.debug('Local description set', localDescription.sdp)

      callback(null, localDescription.sdp, self.processAnswer.bind(
        self))
    }).catch(callback)
  }

  this.getLocalSessionDescriptor = function () {
    return pc.localDescription
  }

  this.getRemoteSessionDescriptor = function () {
    return pc.remoteDescription
  }

  this.send = function (data) {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(data)
    } else {
      logger.warn(
        'Trying to send data over a non-existing or closed data channel')
    }
  }

  /**
   * Callback function invoked when a SDP answer is received. Developers are
   * expected to invoke this function in order to complete the SDP negotiation.
   *
   * @function module:kurentoUtils.WebRtcPeer.prototype.processAnswer
   *
   * @param sdpAnswer - Description of sdpAnswer
   * @param callback -
   *            Invoked after the SDP answer is processed, or there is an error.
   */
  this.processAnswer = function (sdpAnswer, callback) {
    callback = (callback || noop).bind(this)

    var answer = new RTCSessionDescription({
      type: 'answer',
      sdp: sdpAnswer
    })


    logger.debug('SDP answer received, setting remote description')

    if (pc.signalingState === 'closed') {
      return callback('PeerConnection is closed')
    }

    pc.setRemoteDescription(answer, function () {
      callback()
    },
      callback)
  }

  this.toggleCamera = function () {
    this.localStream.getVideoTracks().forEach(track => { track._switchCamera() })
  }

  /**
   * Callback function invoked when a SDP offer is received. Developers are
   * expected to invoke this function in order to complete the SDP negotiation.
   *
   * @function module:kurentoUtils.WebRtcPeer.prototype.processOffer
   *
   * @param sdpOffer - Description of sdpOffer
   * @param callback - Called when the remote description has been set
   *  successfully.
   */
  this.processOffer = function (sdpOffer, callback) {
    callback = callback.bind(this)

    var offer = new RTCSessionDescription({
      type: 'offer',
      sdp: sdpOffer
    })


    logger.debug('SDP offer received, setting remote description')

    if (pc.signalingState === 'closed') {
      return callback('PeerConnection is closed')
    }

    pc.setRemoteDescription(offer)
      .then(function () {
        return pc.createAnswer()
      })
      .then(function (answer) {
        answer = mangleSdpToAddSimulcast(answer)
        logger.debug('Created SDP answer')
        return pc.setLocalDescription(answer)
      })
      .then(function () {
        var localDescription = pc.localDescription
        logger.debug('Local description set', localDescription.sdp)
        callback(null, localDescription.sdp)
      })
      .catch(callback)
  }

  function mangleSdpToAddSimulcast(answer) {
    if (simulcast) {

      logger.warn('Simulcast is only available in Chrome browser.')
    }

    return answer
  }

  /**
   * This function creates the RTCPeerConnection object taking into account the
   * properties received in the constructor. It starts the SDP negotiation
   * process: generates the SDP offer and invokes the onsdpoffer callback. This
   * callback is expected to send the SDP offer, in order to obtain an SDP
   * answer from another peer.
   */
  function start() {
    if (pc.signalingState === 'closed') {
      callback(
        'The peer connection object is in "closed" state. This is most likely due to an invocation of the dispose method before accepting in the dialogue'
      )
    }


    if (videoStream) {
      pc.addStream(videoStream)
    }

    if (audioStream) {
      pc.addStream(audioStream)
    }


    callback()
  }

  if (mode !== 'recvonly' && !videoStream && !audioStream) {
    function getMedia(constraints) {
      if (constraints === undefined) {
        constraints = MEDIA_CONSTRAINTS
      }
      MediaStreamTrack
        .getSources()
        .then(sourceInfos => {
          console.log(sourceInfos);
          let videoSourceId;
          for (let i = 0; i < sourceInfos.length; i++) {
            const sourceInfo = sourceInfos[i];
            if (sourceInfo.kind == 'video' && sourceInfo.facing == ('front')) {
              videoSourceId = sourceInfo.id;
            }
          }
          return getUserMedia(merge(constraints, {
              audio: true,
              video: {
                facingMode: 'user',
                optional: videoSourceId
                  ? [{ sourceId: videoSourceId }]
                  : []
              }
            }))
        })
        .then(stream => {
          console.log('Local Stream is: ', stream);
          videoStream = stream
          localStream = stream
          start()
          return stream
        })
        .catch(noop)
    }
    // 这里我把webcam改成了user
    console.log('sendSource is', sendSource)
    if (sendSource === 'webcam') {
      getMedia(mediaConstraints)
    } else {
      // getScreenConstraints(sendSource, function (error, constraints_) {
      //   if (error)
      //     return callback(error)

      //   constraints = [mediaConstraints]
      //   constraints.unshift(constraints_)
      //   getMedia(recursive.apply(undefined, constraints))
      // }, guid)
    }
  } else {
    setTimeout(start, 0)
  }

  this.on('_dispose', function () {
    self.removeAllListeners()
  })
}
inherits(WebRtcPeer, EventEmitter)




WebRtcPeer.prototype.getLocalStream = function (index) {
  if (this.peerConnection) {
    return this.localStream
  }
}

WebRtcPeer.prototype.getRemoteStream = function (index) {
  if (this.peerConnection) {
    return this.peerConnection.getRemoteStreams()[index || 0]
  }
}

/**
 * @description This method frees the resources used by WebRtcPeer.
 *
 * @function module:kurentoUtils.WebRtcPeer.prototype.dispose
 */
WebRtcPeer.prototype.dispose = function () {
  logger.debug('Disposing WebRtcPeer')

  let pc = this.peerConnection
  let dc = this.dataChannel
  try {
    if (dc) {
      if (dc.signalingState === 'closed') return
      dc.close()
    }

    if (pc) {
      if (pc.signalingState === 'closed') return
      pc.close()
      this.stream = null
    }
  } catch (err) {
    logger.warn('Exception disposing webrtc peer ' + err)
  }

  this.emit('_dispose')
}

//
// Specialized child classes
//

function WebRtcPeerRecvonly(options, callback) {
  if (!(this instanceof WebRtcPeerRecvonly)) {
    return new WebRtcPeerRecvonly(options, callback)
  }

  WebRtcPeerRecvonly.super_.call(this, 'recvonly', options, callback)
}
inherits(WebRtcPeerRecvonly, WebRtcPeer)

function WebRtcPeerSendonly(options, callback) {
  if (!(this instanceof WebRtcPeerSendonly)) {
    return new WebRtcPeerSendonly(options, callback)
  }

  WebRtcPeerSendonly.super_.call(this, 'sendonly', options, callback)
}
inherits(WebRtcPeerSendonly, WebRtcPeer)

function WebRtcPeerSendrecv(options, callback) {
  if (!(this instanceof WebRtcPeerSendrecv)) {
    return new WebRtcPeerSendrecv(options, callback)
  }

  WebRtcPeerSendrecv.super_.call(this, 'sendrecv', options, callback)
}
inherits(WebRtcPeerSendrecv, WebRtcPeer)


export default { WebRtcPeerRecvonly, WebRtcPeerSendonly, WebRtcPeerSendrecv }
