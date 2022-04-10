# iot-gateway-server

The snp.js file contains the parser for SNG communication.
The SNP class requires a socket to be parsed when creating a new object.
Each connected SNG is linked to an SNP object. The SNP/SNG object will handle all communication and parses the People Counter sensordata to the IMBuildings payload format.

App.js is an example implementation.