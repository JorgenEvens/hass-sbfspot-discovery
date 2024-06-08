'use strict';

const MQTT = require('mqtt');
const util = require('node:util');
const readline = require('node:readline');
const { createReadStream, createWriteStream, writeFileSync, existsSync } = require('node:fs');
const { Readable } = require('node:stream');

const [ SBFSPOT_CONFIG ] = process.argv.slice(2);

if (!existsSync(SBFSPOT_CONFIG))
    throw new Error('Could not find config file');

let device = null;
let globals = {};

let config = {};

let devices = [];

function matchVariables(line) {
    const match = /^\s*([a-z0-9_]+)='?([^'"#]*)'?/i.exec(line);

    if (!match) return;

    let key = match?.[1]?.trim();
    let value = match?.[2]?.trim();

    if (/[$"]+/.test(value)) return;
    if (key !== 'value' && !device) return;
    if (key === 'value' && !value) return;

    if (!key) return;

    if (key === 'value' && device !== null) {
        devices.push(device);
        device = { variables: { ...device.variables } };
    }

    if (device === null) {
        device = { variables: {} };
    }

    if (key === 'ts' && /\$\(bashio::config\s+'/.test(line)) {
        const configKey = /\$\(bashio::config\s+'([^']+)/.exec(line)?.[1];

        if (config[configKey])
            value = config[configKey];
    }

    if (key === 'value') {
        device.name = value;
    }

    device.variables[key] = value;
}

function matchConfig(line) {
    const match = /^\s*\/usr\/bin\/mosquitto_pub.*-t\s*([^\s]+)\s*-m\s*(".+}")+/i.exec(line);

    let topic = match?.[1];
    let config = match?.[2];

    if (!config) return;

    config = config.replace(/"'(.+)'"/ig, '$1');

    config = config.replaceAll('$(bashio::addon.name)""', 'SBFspot');

    const vars = { ...globals, ...device.variables };
    for (const key in vars) {
        const value = vars[key];

        config = config.replaceAll('$' + key, value);
        topic = topic.replaceAll('"$' + key + '"', value);
    }

    config = config.trim();

    device.topic = topic;
    device.config = JSON.parse(config);
    device.config = JSON.parse(device.config);
    device.config.state_topic = globals.MQTT_Topic;
}

async function readConfig() {
    const lines = readline.createInterface({
        input: createReadStream(SBFSPOT_CONFIG),
    });

    for await (const line of lines) {
        const match = /^([^#=]+)=(.+)/i.exec(line);

        if (!match) continue;

        const key = match[1]?.trim();
        const value = match[2]?.trim();

        if (!key) continue;

        config[key] = value;
    }
}

async function readInfo(mqtt) {
    const search = config.MQTT_Topic.replace(/[^/]+{[^}]+}/ig, '+');

    const ready = new Promise(resolve => {
        mqtt.on('message', (topic, msg) => resolve({ topic, msg: msg.toString() }));
    });

    await mqtt.subscribeAsync(search);
    let { topic, msg } = await ready;
    msg = JSON.parse(msg);

    globals = { ...msg, ...globals, MQTT_Topic: topic };
}

async function downloadSensorConfig() {
    const res = await fetch('https://raw.githubusercontent.com/habuild/hassio-addons/main/haos-sbfspot/rootfs/usr/bin/sbfspot/mqttSensorConfig');
    const file = './mqttSensorConfig';

    if (!res.ok && !existsSync(file))
        throw new Error('Sensor config not available');
    else if (res.ok) {
        Readable.fromWeb(res.body).pipe(createWriteStream(file));
    }

    return file;
}

(async function() {
    const SENSOR_CONFIG = await downloadSensorConfig();
    await readConfig();

    const mqtt = await MQTT.connectAsync(`mqtt://${config.MQTT_Host}:${config.MQTT_PORT || 1883}`);
    await readInfo(mqtt);

    globals.PLANTNAME = config.Plantname;
    globals.ts = config.DateTimeFormat;

    const stream = createReadStream(SENSOR_CONFIG);
    const lines = readline.createInterface({ input: stream });

    for await (const line of lines) {
        matchVariables(line);
        matchConfig(line);
    }

    const enabledDevices = config.MQTT_Data.split(',');
    const matchers = enabledDevices.map(d => new RegExp(`^${d}\\d*\$`));
    devices = devices.filter(dev => matchers.some(m => m.test(dev.name)));

    for (const dev of devices) {
        await mqtt.publishAsync(dev.topic, JSON.stringify(dev.config), { retain: true });
    }

    await mqtt.endAsync();
})();
