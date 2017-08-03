/*
 Constructor of a pigpio client object that connects with a remote raspberry
 pi and allows manipulation of its gpio pins.
 */
const assert = require('assert');
const EventEmitter = require('events');
class MyEmitter extends EventEmitter {}

// commands 
const BR1=10,BR2=11,TICK=16,HWVER=17,PIGPV=26,PUD=2,MODES=0,MODEG=1;
const READ=3,WRITE=4,PWM=5,WVCLR=27,WVCRE=49,WVBSY=32,WVAG=28,WVCHA=93;
const NOIB=99,NB=19,NP=20,NC=21;
const SLRO=42, SLR=43, SLRC=44, SLRI=94;
const WVTXM = 100, WVTAT = 101, WVDEL = 50, WVAS = 29;
// These command types return p3 as int32, otherwise p3 = uint32
// ie, if (canNeverFailCmdSet.has(cmdValue)) console.log('int32')
const canNeverFailCmdSet = new Set ([HWVER, PIGPV, BR1, BR2, TICK]);
const extReqCmdSet = new Set ([WVCHA, WVAG, SLRO, WVAS]);
const extResCmdSet = new Set ([SLR]); 
/* other pigpio constants */ 
const PUD_OFF = 0, PUD_DOWN = 1, PUD_UP = 2;
const PI_WAVE_MODE_ONE_SHOT=0, PI_WAVE_MODE_REPEAT=1, PI_WAVE_MODE_ONE_SHOT_SYNC=2, PI_WAVE_MODE_REPEAT_SYNC=3;
var info = {
	host: 'localhost',
	port: 8888,
	pipelining: false,
	conn1: false,		// command socket connection status
	conn2: false,		// notification socket connnection status
	pigpioVersion: '',
	hwVersion: '',
	hardware_type: 2,	// 26 pin plus 8 pin connectors (ie rpi model B)
	userGpioMask: 0xfbc6cf9c,
}
/*****************************************************************************/
exports.pigpio = function(pi) {
	var requestQueue = [];
	var callbackQueue = [];
	const net = require('net');
	// update info
	info.host = pi.host || info.host;
	info.port = pi.port || info.port;
	info.pipelining = pi.pipelining || info.pipelining;
	
	// constructor object inherits from EventEmitter
	var that = new MyEmitter(); // can't use prototypal inheritance
	
// Command socket
	var commandSocket = net.createConnection(info.port, info.host, ()=> {
		//'connect' listener
		
		// Update more info
		request(PIGPV,0,0,0,(err,res)=> {
			info.pigpioVersion = res;
			
			request(HWVER,0,0,0, (err,version)=> {
				info.hwVersion = version;
				if ( (version >= 2) && (version<=3) ) {
					info.hardware_type = 1;
					info.userGpioMask = 0x3e6cf93;
				}
				if ( (version>4) && (version<15) ) {
					info.hardware_type = 2;
					info.userGpioMask = 0xfbc6cf9c;  // default
				}
				if ( version>15) {
					info.hardware_type = 3;
					info.userGpioMask = 0xffffffc;
				}
				info.conn1 = true;
				//that.emit('connected'); see notificationSocket
			});
		});
		

	});
	commandSocket.on('error', function(err) {
		that.emit('error', new Error('pigpio-client command socket:'+JSON.stringify(err)));
	});
	commandSocket.on('end', function() {
		if (process.env.DEBUG) {
			console.log('pigpio end received');
		}
	});
	commandSocket.on('close', function() {
		if (process.env.DEBUG) {
			if (info.conn1)
				console.log('pigpio connection closed');
			else console.log('Couldn\'t connect to pigpio@'+info.host+':'+info.port);
		}
	});

	var resBuf = Buffer.allocUnsafe(0);  // see responseHandler()
	
	commandSocket.on('data', (chunk)=> {
	
		var responseHandler = ()=> {
			/*	Extract response parameter (along with extended params) from response buffer
			(resBuf), return response as array argument to queued callback function in
			'callbackQueue.'  p3 contains either error code (if negative) OR response OR
			length of extended parameters.  Decoding cmd tells us if p3 is extended type of
			command. Partial response is saved to be used in subsequent 'data' callbacks.
			If response buffer contains more than a single response, the remainder will
			either be saved or called recursively.   
			*/
			const resArrBuf = new Uint8Array(resBuf).buffer;  // creates an Array Buffer copy
			const cmd = new Uint32Array(resArrBuf, 0, 1);  // view of first 4 32bit params
			var extLen;  // length of extended response
			var res = [];
			var err = null;
			if (canNeverFailCmdSet.has(cmd[0])) {
				// case p3 is uint32, always 16 length
				var p3 = new Uint32Array(resArrBuf,12,1);
				extLen = 0;
				//res[0] = p3[0];
			} else {
				var p3 = new Int32Array(resArrBuf,12,1);
				if (p3[0] > 0) {
					// is this extended response?
					if (extResCmdSet.has(cmd[0])) {
						extLen = p3[0]; // p3 is length of extension
						// is response buffer incomplete?
						if (resArrBuf.byteLength < (extLen + 16))
							return;  // wait for more data
						else {
							let uint8Arr = new Uint8Array(resArrBuf,16,extLen);
							for (let i = 0; i < extLen; i++)
								res[i] = uint8Arr[i];
						}
					} else { 
						//res[0] = p3[0]; // p3 is normal response param
						extLen = 0;
					}
				} else { // p3 is less than (error) or equal (normal) to zero
						extLen = 0;
						if (p3[0] < 0) {
							err = p3[0]; // param[3] contains error code (negative)
							
						}
				}
			}
			if (process.env.DEBUG) {
				let b = resBuf.slice(0,16).toJSON().data;
				console.log("response= ",...b);
				if (extLen > 0) {
					let bx = resBuf.slice(16).toJSON().data;
					console.log("extended params= ",...bx);
				}
			}
			resBuf = resBuf.slice(extLen + 16); // leave remainder for later processing
			// process the response callback
			var callback = callbackQueue.shift(); // FIXME: test for queue underflow
			if (typeof callback === 'function') callback(err,p3[0], ...res);
			else {
				if (err<0)
					that.emit('error', new Error('pigio-client res:'+p3[0]+' cmd:'+cmd[0]));
			}
			// does response buffer contain another response (potentially)?
			if (resBuf.length >= 16) responseHandler(); // recurse
			// check requestQueue for more requests to send
			if (requestQueue.length > 0 && (info.pipelining || callbackQueue.length === 0)) {
				var req = requestQueue.shift();
				commandSocket.write(req.buffer);
				callbackQueue.push(req.callback);
				if (process.env.DEBUG) {
					let b = req.buffer.slice(0,16).toJSON().data;//w/o ext params!
					console.log("deferred request= ",...b);
					if (req.buffer.length > 16) {
						let bx = req.buffer.slice(16).toJSON().data; // w/ext
						console.log("extended params= ",...bx);
					}
				}
			}
			return;
		} // responseHandler
		
		resBuf = Buffer.concat([resBuf, chunk]);
		//if (process.env.DEBUG) {
		//	let b = resBuf.toJSON().data;
		//	console.log("response=\n",...b);
		//}
		if (resBuf.length >= 16) responseHandler();
	});
	
	// helper functions
	var request = (cmd, p1, p2, p3, cb, extArrBuf)=> {
		var bufSize = 16;
		var buf = Buffer.from(Uint32Array.from([cmd, p1, p2, p3]).buffer); //basic
		if ( extReqCmdSet.has(cmd)) {
			//following is not true for waveAddSerial!
			//assert.equal(extArrBuf.byteLength, p3, "incorrect p3 or array length");
			bufSize = 16 + extArrBuf.byteLength;
			let extBuf = Buffer.from(extArrBuf); //extension
			buf = Buffer.concat([buf,extBuf]);
		}

		// Queue request if request queue is no empty OR callback queue is not empty and pipelining disabled
		if (requestQueue.length>0 || (callbackQueue.length>0 && !info.pipelining))
			requestQueue.push({buffer:buf, callback:cb });
		else {
			commandSocket.write(buf);
			callbackQueue.push(cb);
			if (process.env.DEBUG) {
				let b = buf.slice(0,16).toJSON().data; // exclude extended params!
				console.log("request= ",...b);
				if (bufSize > 16) {
					let bx = buf.slice(16).toJSON().data; // extended params
					console.log("extended params= ",...bx);
				}
			}
		}
	} // request()
	
	var pigpv = (callback)=> {
		request(PIGPV,0,0,0,callback);
	}
	
	var hwver = (callback)=> {
		request(HWVER,0,0,0,callback);
	}
	
// Notifications socket = ToDo: check for notification errors response (res[3])
	var handle;
	var notificationSocket;
	var chunklet = Buffer.allocUnsafe(0); //notify chunk fragments
commandSocket.once('connect', ()=> {
	notificationSocket = net.createConnection(info.port, info.host, ()=> {
		info.conn2 = true;
		that.emit('connected');
		if (process.env.DEBUG)
		console.log('notifier socket connected on rpi host '+info.host);
		let noib = Buffer.from(new Uint32Array([NOIB,0,0,0]).buffer);
		notificationSocket.write(noib, ()=>{
			// connect listener once to get handle from NOIB request
			notificationSocket.once('data', (resBuf)=> {
				const res = new Uint32Array(resBuf);
				handle = res[3];
				if (process.env.DEBUG)
				console.log('opened notification socket with handle= '+handle);
				
				// connect listener that processes notification chunks
				notificationSocket.on('data', function (chunk) {
					// monitors all gpio bits and issues callback for all registered notifiers.
					var buf = Buffer.concat([chunklet,chunk]);
					let remainder = buf.length%12;
					
					for (let i=0; i<buf.length-remainder; i+=12) {
						let seqno = buf.readUInt16LE(i+0),
							flags = buf.readUInt16LE(i+2),
							tick = buf.readUInt32LE(i+4),
							level = buf.readUInt32LE(i+8);
						//if (flags === 0)
							for (let nob of notifiers.keys())
								nob.func(level, tick);
					}
					//save the chunk remainder
					chunklet = buf.slice(buf.length-remainder);
/*					// debug
					if (remainder) {
						console.log('got remainder chunklet: '+remainder);	
					}
*/
				});
			});
		});
	});

	
	notificationSocket.on('error', function(err) {
		that.emit('error', new Error('pigpio-client notification socket:'+JSON.stringify(err)));
	});
	notificationSocket.on('end', function() {
		if (process.env.DEBUG) {
			console.log('pigpio notification end received');
		}
	});
	notificationSocket.on('close', function() {
		if (process.env.DEBUG) {
			if (info.conn2)
				console.log('pigpio notification closed');
			else
				console.log('Couldn\'t connect to pigpio@'+info.host+':'+info.port);
		}
	});
});
	
	/*** Public Methods ***/
	
	that.request = request;

// Notifications
//	Must **always** use 'request()' to configure/control pigpio.  Ie, don't to this:
//	commandSocket.write(...);  // will screw up request callbackQueue!!!
	const MAX_NOTIFICATIONS = 32;
	var nID = 0;
	var notifiers = new Set();
	var monitorBits = 0;
	that.startNotifications = function(bits, cb) {
		if (notifiers.size = MAX_NOTIFICATIONS) {
			that.emit('error', new Error('Notification limit reached, cannot add this notifier'));
			return null;
		}

		// Registers callbacks for this gpio
		var nob = {
			id: nID++,
			func: cb,
			bits: +bits,
		};
		notifiers.add(nob);
		
		// Update monitor with bits
		monitorBits |= bits;
		// send 'notifiy begin' command
		request(NB, handle, monitorBits, 0);
		
		//return the callback 'id'
		return nob.id;
	}
	that.pauseNotifications = function(cb) {
	// Caution:  This will pause **all** notifications!
		request(NP, handle, 0, 0, cb);
	}
	that.stopNotifications = function(id) {
		// Clear monitored bits and unregister callback
		for (let nob of notifiers.keys())
			if (nob.id === id) {
				monitorBits &= ~nob.bits; // clear gpio bit in monitorBits
				// Stop the notifications on pigpio hardware
				request(NB, handle, monitorBits, 0, ()=>{
					console.log('last call for notifier id'+nob.id);
					nob.func(null,null); // last callback with null arguments
					notifiers.delete(nob); // remove this notifier object
				});
			}
	}
	that.closeNotifications = function(cb) {
	// Caution: This will close **all** notifications!
		request(NC, handle, 0, 0, cb);
	}
	
	that.isUserGpio = function(gpio) {
		return ((1<<gpio) &  info.userGpioMask)? true : false;
	}
	that.getInfo = function () {
		return (`\connected pigpiod info:
\thost : ${info.host}
\tport : ${info.port}
\tpigpio version : ${info.pigpioVersion}
\tRPi CPU info : ${info.hwVersion}
\tRPi HW type : ${info.hardware_type}
\tUser GPIO : ${info.userGpioMask.toString(16)}
\tpipelining : ${info.pipelining}
\tcommand socket connected : ${info.conn1}
\tnotifications socket connected : ${info.conn2}`);
	}
	that.getCurrentTick = function(cb) {
		that.request(TICK,0,0,0,cb);
	}
	that.readBank1 = function(cb) {
		that.request(BR1,0,0,0,cb);
	}
	that.destroy = function() {
		// Shoul only be called if an error occurs on socket
		commandSocket.destroy();
		notificationSocket.destroy();
	}
	that.end = function(cb) {
		// return all gpio to input mode with pull-up/down?
		// clear any waveforms?
		// other resets?
		let ended = false;
		commandSocket.end();
		notificationSocket.end();
		commandSocket.on('close', () => {
			if (ended) {
				if (typeof cb === 'function') cb();
			} else ended = true;
		});
		notificationSocket.on('close', ()=>{
			if (ended) {
				if (typeof cb === 'function') cb();
			} else ended = true;
		});
		//todo: change info.conn1, info.conn2 to false
	}

/*___________________________________________________________________________*/

that.gpio = function(gpio) {
	var _gpio = function(gpio) {
		
		var modeSet = function(gpio, mode, callback) {
			if (typeof gpio !== 'number' || typeof mode !== 'string') {
				throw new Error('TypeError: pigpio.modeSet argument types are number and string');
			}
			if ( !that.isUserGpio(gpio) ) {
				throw new Error('PigpioError: pigpio.modeSet gpio argument is not user gpio');
			}
			var m = /^outp?u?t?/.test(mode)? 1 : /^inp?u?t?/.test(mode)? 0 : undefined;
			if (m === undefined) {
				throw new Error('pigpio.modeSet: invalid mode string');
				return;
			}
			request(MODES,gpio,m,0,callback);
		}
		
		var pullUpDown = function(gpio, pud, callback) {
			if (typeof gpio !== 'number' || typeof pud !== 'number') {
				throw new Error('TypeError: pigpio.pullUpDown argument is not a number');
			}
			if ( !that.isUserGpio(gpio) ) {
				throw new Error('PigpioError: pigpio.pullUpDown gpio argument is not user gpio');
			}
			// Assume pigpio library handles range error on pud argument!
			request(PUD,gpio,pud,0,callback);
		}

	// basic methods
		this.modeSet = function(...args) {modeSet(gpio, ...args)}
		this.pullUpDown = function(...args) {pullUpDown(gpio, ...args)}
		this.write = function(level, callback) {
			
			if ( (+level>=0) && (+level<=1) ) {
				request(WRITE,gpio,+level,0,callback);
			}
			else throw new Error('pigpio.write error: bad gpio or level');
		}
		this.read = function(callback) {
			request(READ,gpio,0,0,callback);
		}
		this.modeGet = function(callback) {
			request(MODEG,gpio,0,0,callback);
		}
	// PWM
		this.analogWrite = function(dutyCycle, cb) {
			request(PWM,gpio,dutyCycle,0,cb);
		}
	// Notification methods
		var notifierID = null;
		
		this.notify = function (callback) {
			// only allow one notifier per gpio object
			if (notifierID !== null) {
				that.emit('error', new Error('Notifier already registered for this gpio.'));
				return;
			}
			// get the current levels to compare against for changes
			that.readBank1((levels)=>{
				let oldLevels = levels;
				// now detect if gpio level has changed
				let gpioBitValue = 1<<gpio;
				notifierID = that.startNotifications(gpioBitValue,(levels, tick)=> {
//Todo: janky code here, you fix it Mr Awesome!
				if (levels===null) {
						callback(null,null);
						return;
					}
					let changes = oldLevels ^ levels;
					oldLevels = levels;
					if (gpioBitValue & changes) {
						let level = (gpioBitValue&levels)>>gpio;
						callback(level,tick);
					}
				});
			});
			
		}
		this.endNotify = function () {
			if (notifierID !== null) that.stopNotifications(notifierID);
			notifierID = null;
		}

	// Waveform generation methods
		this.waveClear = function(callback) {
			request(WVCLR,0,0,0,callback);
		}
		this.waveCreate = function(callback) {
			request(WVCRE,0,0,0,callback);
		}
		this.waveBusy = function(callback) {
			request(WVBSY,0,0,0,callback);
		}
		this.waveNotBusy = function(time, cb) {
			let timer, callback;
			
		if (typeof time !== 'number') {
				timer = 25;
				callback = time;
			} else {
				timer = time;
				callback = cb;
			}
			var waitWaveBusy = (done)=> {
				setTimeout( ()=> {
					request(WVBSY,0,0,0, (err, busy)=> {
						if (!busy) done();
						else waitWaveBusy(done);
					});
				},timer);
			}
			waitWaveBusy(callback);
		}
		
		this.waveAddPulse = function(tripletArr, callback) {
			//test triplets is an array of arrays
			tripletArr.forEach( function(triplet) {
				assert.equal( (Object.prototype.toString.apply(triplet)),'[object Array]',"tripletArr not an array");
				assert.equal(triplet.length, 3, "triplet array length is not 3");
			});
			
			// use Typed Arrays
			var arrBuf = new ArrayBuffer(tripletArr.length*3*4);  // items are 3 x 32-bit values
			var uint32Triplet = new Uint32Array(arrBuf,0,tripletArr.length*3);  // 32-bit view of buffer
			let i = 0;
			tripletArr.forEach(function(triplet) {
				uint32Triplet[i+0] = triplet[0]<<gpio; // 'set' gpio (bit value)
				uint32Triplet[i+1] = triplet[1]<<gpio; // 'clear' gpio (bit value)
				uint32Triplet[i+2] = triplet[2];
				i = i + 3;
			});
			// ship it
			request(WVAG,0,0,arrBuf.byteLength,callback,arrBuf);
		}
		
		this.waveChainTx = function(paramArray, callback) {
			// Todo: assert paramArray elements are single property objects
			var chain = [];
			paramArray.forEach( (param) => {
				let temp;
				if (param.hasOwnProperty("loop")) {
					temp = chain.concat(255,0);
				}
				else if (param.hasOwnProperty("repeat")) {
					assert.equal(param.repeat<=0xffff, true, "param must be <= 65535");
					temp = chain.concat(255,1, param.repeat&0xff, param.repeat>>8);
				}
				else if (param.hasOwnProperty("delay")) {
					assert.equal(param.delay<=0xffff, true, "param must be <= 65535");
					temp = chain.concat(255,2, param.delay&0xff, param.delay>>8);
				}
				else if (param.hasOwnProperty("waves")) {
					param.waves.forEach( (wid) => {
						assert.equal(wid<=250, true, "wid must be <= 250");
					});
					temp = chain.concat(param.waves);
				}
				chain = temp;
				temp = [];
			});

			var arrBuf = new ArrayBuffer(chain.length);
			var buffer = new Uint8Array(arrBuf);
			for (let i=0; i<chain.length; i++) buffer[i] = chain[i];
			request(WVCHA,0,0,arrBuf.byteLength,callback,arrBuf);
		}
		
		this.waveSendSync = function(wid, cb) {
			request(WVTXM, wid, PI_WAVE_MODE_ONE_SHOT_SYNC, 0, cb);
		}
		this.waveSendOnce = function(wid, cb) {
			request(WVTXM, wid, PI_WAVE_MODE_ONE_SHOT, 0, cb);
		}
		this.waveTxAt = function(cb) {
			request(WVTAT, 0, 0, 0, cb);
		}
		this.waveDelete = function(wid, cb) {
			request(WVDEL, wid, 0, 0, cb);
		}
		
		this.serialReadOpen = function(baudRate, dataBits, callback) {
			var arrBuf = new ArrayBuffer(4);
			var dataBitsBuf = new Uint32Array(arrBuf,0,1);
			dataBitsBuf[0] = dataBits;
			request(SLRO, gpio, baudRate, 4, callback, arrBuf);
		}
		this.serialRead = function(count, callback) {
			request(SLR, gpio, count, 0, callback);
		}
		this.serialReadClose = function(callback) {
			request(SLRC, gpio, 0,0, callback);
		}
		this.serialReadInvert = function(mode, callback) {
			var flag;
			if (mode === 'invert') flag = 1;
			if (mode === 'normal') flag = 0;
			assert(typeof flag !== 'undefined');
			request(SLRI, gpio, flag, 0, callback);
		}
		this.waveAddSerial = function(baud, bits, delay, data, callback) {
			let dataBuf = Buffer.from(data);
			let paramBuf = Buffer.from(Uint32Array.from([bits,2,delay]).buffer);
			let buf = Buffer.concat([paramBuf,dataBuf]);
			// request take array buffer (this conversion from ZachB on SO)
			//let arrBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			request(WVAS, gpio, baud, buf.length, callback, buf);
		}
	
	}//var gpio
	_gpio.prototype = that; // inheritance
	return new _gpio(gpio);
}//that.gpio constructor
/*
--------------- Serial Port Construtor ----------------------------------------
Return a serialport object using specified pins.  Frame format is 1-32 databits,
no parity and 1 stop bit.  Baud rates from 50-250000 are allowed.  For now, we
implement a serial port suitable for interfacing with AVR/Arduino.
Usage: Application must poll for read data to prevent data loss.  Read method
uses callback.  (Desire to make this readable.read() like)
Todo: - make rts/cts, dsr/dtr more general purpose.
	  - implement duplex stream api
*/
that.serialport = function(rx,tx,dtr) {
	var _serialport = function(rx, tx, dtr) {
		var baud, bits, delay=0, isOpen=false, current_wid = null, next_wid;
		// check gpio pins are valid and (todo) available
		if (!(that.isUserGpio(rx)&&that.isUserGpio(tx)&&that.isUserGpio(dtr)))
			return undefined;
		var _rx = new that.gpio(rx);
		var _tx;
		if (tx === rx) { // loopback mode
			_tx = _rx;
		} else _tx = new that.gpio(tx);
		var _dtr = new that.gpio(dtr);
		_rx.modeSet('input'); // need a pullup?
		_tx.modeSet('output');
		_tx.write(1);
		_dtr.modeSet('output');
		_dtr.write(1);
		this.open = function(baudrate, databits, callback) {
			baud = baudrate || 9600;
			baud = (49>baud<250001) ? baud : 0;
			bits = databits || 8;
			bits = (0>bits<33) ? bits : 0;
			if (baud>0 && bits>0) {
				// initialize rx
				_rx.serialReadOpen(baud, bits, (err)=> {
					if (err===-50) {
						// if err is -50 we may have crashed without closing
						_rx.serialReadClose(); // close it and try again
						isOpen = false;
						callback('port in use, closing, try again');
					} else if (err) {
						isOpen = false;
						callback('Error opening serialport: '+err);
					}
					else { // serial rx is open
						isOpen = true;
						// pulse dtr pin to reset Arduino
						_dtr.write(0, ()=> {
							setTimeout( ()=> {_dtr.write(1)}, 10);
						});
						callback(null);
					}
				});
				// initialize tx
				//_tx.waveClear();
				request(53,0,0,0);  // init new wave
			} else {
				isOpen = false;
				callback("Error: invalid arguments");
			}
		}
		this.read = function(size, cb) {
			let count, callb;
			if (typeof size === 'function') {
				callb = size;
				count = 1;
			} else {
				callb = cb;
				count = size || 1; // must read at least a byte at a time
			}
			if (isOpen) {
				// Todo: implement readable.read() like.  For now just use callback.
	//If the size argument is not specified, all of the data contained
	//in the internal buffer will be returned.
				_rx.serialRead(count, (err,len,...bytes)=> {
					if (err) {
						callb(err);
					} else if (len===0) {
						callb(null,null);
					} else {
						let buf = Buffer.from(bytes);
						callb(null,buf);
					}
				});
			} else callb(null);
		}
		this.write = function(data) {
			if (isOpen) {
			_tx.waveAddSerial(baud, bits, delay, data, () => {
				_tx.waveCreate((err,id)=> {
					next_wid = id;
					//for now just wait not busy.  Todo: sync it
					_tx.waveNotBusy( ()=> {
						_tx.waveSendOnce(next_wid);
						// clean up, recycle wids
						if (current_wid !== null) {
							_tx.waveDelete(current_wid);
						}
						current_wid = next_wid;
					});
				});
			});
			}
		}
		this.close = function(callback) {
			if (isOpen) {
				_rx.serialReadClose( () => {
					isOpen = false;
					if (callback) callback();
				});
			} else if (callback) callback();
		}
		this.end = function(callback) {
			_rx.serialReadClose( () => {
			_tx.modeSet('input', () => { // end()
			_dtr.modeSet('input',() => { // end()
				//_serialport = undefined; // ready for garbage collection??? 
				if (typeof callback === 'function') {
					callback();
				}
			}); }); });
		}

	}//serialport
	_serialport.prototype = that;
	return new _serialport(rx,tx,dtr);
}//pigpio serialport constructor
	return that;
}//pigpio constructor
