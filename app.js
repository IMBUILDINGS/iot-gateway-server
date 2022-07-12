#!/usr/bin/env node

const SNP = require('./snp.js');
const net = require('net');
const config = require('./Example-config.json');
const fs = require('fs');


function onTCPConnect(socket) {
    let snp = new SNP(socket);
    snp.on('payload', (data) => {
        console.log("payload: \n" + data.toString('HEX'));
        console.log('The gateway id: '+ snp.id);
    });
    // console.log(snp.PacketType);
    // console.log(snp.uP);
    // console.log(snp.ConfigEEPROM);

}

let tcpServer = net.createServer(onTCPConnect);
tcpServer.listen(config.listenport, () => {
    console.log(`Server listening on port ${config.listenport}`);
});

