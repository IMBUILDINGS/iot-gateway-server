const crc = require('crc');
const moment = require('moment');
const config = require('./example-config.json');
const EventEmitter = require('events');

module.exports = class SNP extends EventEmitter {

	gateway = {}
	id = null
	version = null
	packetBuffer = new Array()
	rcvBuffer = Buffer.alloc(0)
	bufferSynced = false
	nodes = []
	log = {}
	state = 0
	last_data_received = moment.utc().unix()
	connecttime = moment.utc().unix()
	socket = {}

	constructor(socket) {
		super();
		let socketTimeout = (config.timeout != undefined) ? config.timeout : 15;
		socket.setTimeout(60000 * socketTimeout);
		console.log(`Gateway Connected: ${socket.remoteAddress}`);
		this.socket = socket
		this.socket[setTimeout] = 60000 * 20

		this.socket.on('data', (data) => {
			this.rcvBuffer = Buffer.concat([this.rcvBuffer, data]);
			this.processReceiveBuffer();
			this.payload = {};
			this.payload = this.parsePacketBuffer();
			if (this.payload != null && this.payload != undefined && this.payload != {}) {
				this.emit('payload', this.payload);
			}
		});
		this.socket.on('close', (hadError) => {
			console.log('close');
		});

		this.socket.on('end', () => {
			console.log('end');
		})

		this.socket.on('error', (err) => {
			console.log('error');
		});

		this.socket.on('timeout', () => {
			console.log('timeout');
		});
		this.initGateway
	}

	DstSrc = {
		uP: 0x0,
		Server: 0x3,
		dataEEPROM: 0x6,
		configEEPROM: 0x7
	};

	PacketType = {
		SensorData: 0x01,
		CommandSet: 0x10,
		Answer: 0x11
	};

	uP = {
		Functions: {
			ReadSNGInfo: 0x00,
			DataEEPROM: 0x02,
			RTC: 0x03,
			P2PWireless: 0x04
		},
		DataEEPROMCommands: {
			ReadInfo: 0x01,
			IncreasePointer: 0x05
		},
		RTCCommands: {
			ReadRTC: 0x01,
			WriteRTC: 0x02
		},
		P2PWirelessCommands: {
			GetNode: 0x03
		},
		cmdIncreaseReadPointer: () => {
			return [this.uP.Functions.DataEEPROM, this.uP.DataEEPROMCommands.IncreasePointer];
		},
		cmdReadSNGInfo: () => {
			return [this.uP.Functions.ReadSNGInfo];
		},
		cmdGetNode: (nodeIndex) => {
			nodeIndex = nodeIndex & 0xFF;
			return [this.uP.Functions.P2PWireless, this.uP.P2PWirelessCommands.GetNode, nodeIndex];
		},
		cmdSetClockToUTC: () => {
			let data = [
				this.uP.Functions.RTC,
				this.uP.RTCCommands.WriteRTC,
				this.bcd(moment.utc().year() - 2000),
				this.bcd(moment.utc().month() + 1),
				this.bcd(moment.utc().date()),
				this.bcd(moment.utc().hour()),
				this.bcd(moment.utc().minute()),
				this.bcd(moment.utc().second())
			];
			return data;
		}
	};

	ConfigEEPROM = {
		Commands: {
			Read: 0x01,
			Write: 0x02
		},
		cmdGetNodeId() {
			return [0x01, 0xFA, 0x06];
		}
	};

	bcd(dec) {
		return ((dec / 10) << 4) + (dec % 10);
	}

	unbcd(bcd) {
		return ((bcd >> 4) * 10) + bcd % 16;
	}

	createPacket(dst, src, type, payload) {
		let packet = Buffer.alloc(payload.length + 3);
		payload = Buffer.from(payload);
		packet[0] = dst * 0x10 + src;
		packet[1] = type;
		packet[2] = payload.length;

		for (let i = 0; i < payload.length; i++) {
			packet[3 + i] = payload[i];
		}

		packet = this.addCRC(packet);

		return packet;
	}

	addCRC(packet) {
		let crcBuffer = Buffer.alloc(2);
		crcBuffer.writeUInt16LE(crc.crc16xmodem(packet));
		packet = Buffer.from(packet);

		return Buffer.concat([packet, crcBuffer]);
	}

	checkCRC(packet) {
		return (packet.readUInt16LE(packet.length - 2) == crc.crc16xmodem(packet.slice(0, packet.length - 2))) ? true : false
	}

	parsePacket(packet) {
		let parsedPacket = {
			validPacket: false
		};

		if (packet.length < 5) return parsedPacket;

		parsedPacket.validPacket = this.checkCRC(packet);
		if (parsedPacket.validPacket === false) return parsedPacket;

		parsedPacket.destination = packet[0] >> 4;
		parsedPacket.source = packet[0] & 0x0F;
		parsedPacket.packetType = packet[1];
		parsedPacket.dataLength = packet[2];

		parsedPacket.data = [];
		for (let i = 0; i < parsedPacket.dataLength; i++) {
			parsedPacket.data.push(packet[i + 3]);
		}

		parsedPacket = this.parseData(parsedPacket);
		return parsedPacket;
	}

	parseData(parsedPacket) {
		let parsedData = {};
		switch (parsedPacket.source) {
			case this.DstSrc.uP:
				//EEPROM Read Info Result
				if (parsedPacket.packetType == this.PacketType.Answer &&
					parsedPacket.data[0] == this.uP.Functions.DataEEPROM &&
					parsedPacket.data[1] == this.uP.DataEEPROMCommands.ReadInfo) {
					parsedData.content = 'eeprominfo';
					parsedData.readPointer = 0;
					parsedData.writePointer = 0;
					parsedData.infoBlockSize = 0x20 * 0x20;
					break;
				}

				if (parsedPacket.packetType == this.PacketType.Answer &&
					parsedPacket.data[0] == this.uP.Functions.ReadSNGInfo) {
					parsedData.content = 'snginfo';
					parsedData.version = "v" + parsedPacket.data[1] + "." + parsedPacket.data[2] + "." + parsedPacket.data[3];
					if (parsedPacket.data.length > 4) {
						parsedData.maxNodes = parsedPacket.data[4];
					}
					if (parsedPacket.data.length > 6) {
						switch (parsedPacket.data[6]) {
							case 0x24: parsedData.RFType = "2.4GHz"; break;
							case 0x89: parsedData.RFType = "868MHz"; break;
							case 0x91: parsedData.RFType = "915MHz"; break;
							default: parsedData.RFType = "Not available"; break;
						}

						switch (parsedPacket.data[7]) {
							case 0x00: parsedData.interface = "RS232"; break;
							case 0x01: parsedData.interface = "Ethernet"; break;
							case 0x02: parsedData.interface = "2G/3G"; break;
							case 0x04: parsedData.interface = "4G"; break;
							case 0x10: parsedData.interface = "USB"; break;
							case 0xFF: parsedData.interface = "Ethernet"; break;
						}
					}
				}

				if (parsedPacket.packetType == this.PacketType.Answer &&
					parsedPacket.data[0] == this.uP.Functions.RTC &&
					parsedPacket.data[1] == this.uP.RTCCommands.ReadRTC) {
					parsedData.content = 'clockinfo';
					let datetime = moment.utc();
					datetime.year(2000 + this.unbcd(parsedPacket.data[2]));
					datetime.month(this.unbcd(parsedPacket.data[3]) - 1);
					datetime.date(this.unbcd(parsedPacket.data[4]));
					datetime.hour(this.unbcd(parsedPacket.data[5]));
					datetime.minute(this.unbcd(parsedPacket.data[6]));
					datetime.second(this.unbcd(parsedPacket.data[7]));
					datetime.millisecond(0);
					parsedData.datetime = datetime.format();
				}

				if (parsedPacket.packetType == this.PacketType.Answer &&
					parsedPacket.data[0] == this.uP.Functions.P2PWireless &&
					parsedPacket.data[1] == this.uP.P2PWirelessCommands.GetNode) {
					parsedData.content = 'nodeinfo';
					parsedData.nodeIndex = parsedPacket.data[2];
					parsedData.nodeActive = (parsedPacket.data[3] == 0x01) ? true : false;
					parsedData.nodeId = Buffer.from(parsedPacket.data.slice(4, 11)).toString('HEX');
				}

				break;
			case this.DstSrc.dataEEPROM:
				if (parsedPacket.packetType == this.PacketType.SensorData) {
					parsedData.content = 'sensordata';
					let datetime = moment.utc();
					datetime.year(2000 + this.unbcd(parsedPacket.data[0]));
					datetime.month(this.unbcd(parsedPacket.data[1]) - 1);
					datetime.date(this.unbcd(parsedPacket.data[2]));
					datetime.hour(this.unbcd(parsedPacket.data[3]));
					datetime.minute(this.unbcd(parsedPacket.data[4]));
					datetime.second(this.unbcd(parsedPacket.data[5]));
					datetime.millisecond(0);
					parsedData.datetime = datetime.format();

					parsedData.nodeIndex = parsedPacket.data[6];
					parsedData.nodeId = Buffer.from(parsedPacket.data.slice(7, 13)).toString('HEX');
					parsedData.rssi = parsedPacket.data[13];
					parsedData.data = parsedPacket.data.slice(14, parsedPacket.data.length - 1);
					parsedData.sequence = parsedPacket.data[parsedPacket.data.length - 1];
				}

				break;
			case this.DstSrc.configEEPROM:
				if (parsedPacket.packetType == this.PacketType.Answer &&
					parsedPacket.data[0] == 0x01 &&
					parsedPacket.data[1] == 0xFA) {
					parsedData.content = 'nodeid';
					parsedData.nodeId = Buffer.from(parsedPacket.data.slice(3)).toString('HEX');
				}
				break;
			default:
				break;
		}

		parsedPacket.parsedData = parsedData;
		return parsedPacket;
	}

	parseSensorData(sensorData) {
		let payload = null;
		if (sensorData.data.length == 8) {
			//People Counter
			console.log('IoT People Counter');
			let datetime = moment.utc(sensorData.datetime);
			let batteryVoltage = sensorData.data[6] / 256 * 3;

			payload = Buffer.alloc(24);
			payload[0] = 0x02;
			payload[1] = 0x04;
			payload.write(sensorData.nodeId, 2, 'HEX');
			payload[8] = 0;
			payload.writeUInt16BE(batteryVoltage * 100, 9);
			//payload[9] = 0; //Battery voltage
			//payload[10] = 0;
			payload.writeInt8(0.55 * sensorData.rssi - 118.5, 11);

			payload[12] = this.bcd((datetime.year() - (datetime.year() - 2000)) / 100);
			payload[13] = this.bcd(datetime.year() - 2000);
			payload[14] = this.bcd(datetime.month() + 1);
			payload[15] = this.bcd(datetime.date());
			payload[16] = this.bcd(datetime.hour());
			payload[17] = this.bcd(datetime.minute());
			payload[18] = this.bcd(datetime.second());

			payload[19] = sensorData.data[1];
			payload[20] = sensorData.data[0];
			payload[21] = sensorData.data[4];
			payload[22] = sensorData.data[3];
			payload[23] = sensorData.data[5];
		}

		if (payload != null) {
			return payload
		}
	}

	processReceiveBuffer() {
		let i = 0;
		while (i < this.rcvBuffer.length) {
			if (this.rcvBuffer.length < 6) return;
			let dataLength = this.rcvBuffer[i + 2];
			let packetStart = i;
			let packetEnd = i + dataLength + 5;

			if (this.rcvBuffer.length >= dataLength + 5 && (dataLength < 64 || dataLength != 0)) {
				let packet = Buffer.alloc(dataLength + 5);
				this.rcvBuffer.copy(packet, 0, packetStart, packetEnd);
				let validPacket = this.checkCRC(packet);
				if (validPacket) {
					this.packetBuffer.push(packet);
					this.bufferSynced = true;
					this.rcvBuffer = this.rcvBuffer.slice(packetEnd, this.rcvBuffer.length);
					i = 0;
				} else if (this.bufferSynced == false || (this.bufferSynced == true && validPacket == false)) {
					console.log(`${this.id}: No valid packet found in buffer (${this.rcvBuffer.length})`);
					let newBuffer = Buffer.alloc(this.rcvBuffer.length - 1);
					this.rcvBuffer.copy(newBuffer, 0, 1, this.rcvBuffer.length);
					this.rcvBuffer = newBuffer;
					i++;
				}
			} else {
				return;
			}
		}
	}

	initGateway() {
		if (this.version == null) {
			//get gateway info
			this.socket.write(this.createPacket(this.DstSrc.uP, this.DstSrc.Server, this.PacketType.CommandSet, this.uP.cmdReadSNGInfo()));
		} else if (this.id == null) {
			this.socket.write(this.createPacket(this.DstSrc.configEEPROM, this.DstSrc.Server, this.PacketType.CommandSet, this.ConfigEEPROM.cmdGetNodeId()));
		} else if (this.nodes.length < 10) {
			this.socket.write(this.createPacket(this.DstSrc.uP, this.DstSrc.Server, this.PacketType.CommandSet, this.uP.cmdGetNode(this.nodes.length)));
		} else {
			//No clock change on the 31st of the month
			if (moment.utc().date() == 31) {
				return;
			}

			console.log(`${this.id}: Set Clock`);
			this.socket.write(this.createPacket(this.DstSrc.uP, this.DstSrc.Server, this.PacketType.CommandSet, this.uP.cmdSetClockToUTC()));
			this.state = 1;
		}
	}

	parsePacketBuffer() {
		while (this.packetBuffer.length > 0) {
			let packet = this.packetBuffer.shift();
			let parsedPacket = this.parsePacket(packet);
			let parsedData = parsedPacket.parsedData;

			switch (parsedData.content) {
				case 'snginfo':
					this.version = parsedData.version;
					this.RFType = parsedData.RFType;
					this.interface = parsedData.interface;
					this.maxNodes = parsedData.maxNodes;
					break;
				case 'nodeid':
					this.id = parsedData.nodeId;
					//this.state = 1; 
					console.log(`Gateway identified: ${this.id} - ${this.version} (${this.socket.remoteAddress})`);
					break;
				case 'sensordata':
					if (this.state > 0) {
						console.log(`${this.id} (${this.version}): data received`);

						this.last_data_received = moment.utc().unix();
						let command = this.uP.cmdIncreaseReadPointer();
						let packet = this.createPacket(this.DstSrc.uP, this.DstSrc.Server, this.PacketType.CommandSet, command);
						this.socket.write(packet);
						return this.parseSensorData(parsedData);
					}
					break;
				case 'nodeinfo':
					if (parsedData.nodeIndex != this.nodes.length) break; //only process when it is the next node

					if (parsedData.nodeActive) {
						this.nodes.push(parsedData.nodeId);
					} else {
						this.nodes.push(null);
					}

					if (this.nodes.length == 10) {
						console.log(this.nodes);
					}
					break;
			}

			if (this.state == 0) {
				this.initGateway();
			}
		}
	}
}
