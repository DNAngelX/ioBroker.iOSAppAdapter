"use strict";

const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

class FakeAdapter {
	constructor(options) {
		this.options = options;
		this.namespace = "iobapp.0";
		this.version = "0.2.1";
		this.config = {};
		this.log = {
			debug: () => {},
			error: () => {},
			info: () => {},
			warn: () => {},
		};
	}

	on() {}
}

function makeAdapter() {
	const createAdapter = proxyquire("./main", {
		"@iobroker/adapter-core": {
			Adapter: FakeAdapter,
		},
	});
	return createAdapter({});
}

function makeSocket() {
	return {
		/** @type {any[]} */
		sent: [],
		send(payload) {
			this.sent.push(JSON.parse(payload));
		},
	};
}

describe("Protocol v2 WebSocket contract", () => {
	it("responds to hello with versioned capabilities", () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		adapter.handleHello(socket);

		expect(socket.sent).to.have.length(1);
		expect(socket.sent[0]).to.deep.include({ action: "hello" });
		expect(socket.sent[0].data.protocolVersion).to.equal(2);
		expect(socket.sent[0].data.adapterVersion).to.equal("0.2.1");
		expect(socket.sent[0].data.capabilities).to.include.members([
			"getActionCatalog",
			"executeAction",
			"requestSensorRefresh",
			"notificationCommands",
			"diagnostics",
			"silentPushWake",
		]);
		expect(socket.sent[0].data.supportedActions).to.include.members([
			"setDeviceToken",
			"set",
			"setPresence",
			"notification",
			"notificationAck",
			"getActionCatalog",
			"executeAction",
			"requestSensorRefresh",
			"notificationCommand",
		]);
	});

	it("returns runtime and NFC tag actions in the action catalog", async () => {
		const adapter = makeAdapter();
		adapter.getForeignObjectsAsync = async () => ({
			"iobapp.0.tags.frontdoor": {
				common: { name: "Front Door" },
			},
		});
		const socket = makeSocket();

		await adapter.handleGetActionCatalog(socket);

		expect(socket.sent).to.have.length(1);
		expect(socket.sent[0]).to.deep.equal({
			action: "getActionCatalog",
			data: {
				actions: [
					{
						id: "requestSensorRefresh",
						name: "Sensoren aktualisieren",
						type: "runtime",
					},
					{
						id: "request_location_update",
						name: "Standort senden",
						type: "notificationCommand",
					},
					{
						id: "command_update_sensors",
						name: "Sensoren per Command aktualisieren",
						type: "notificationCommand",
					},
					{
						id: "update_widgets",
						name: "Widgets aktualisieren",
						type: "notificationCommand",
					},
					{
						id: "update_watch",
						name: "Watch aktualisieren",
						type: "notificationCommand",
					},
					{
						id: "clear_notification",
						name: "Notifications löschen",
						type: "notificationCommand",
					},
					{
						id: "tag:frontdoor",
						name: "Front Door",
						type: "tagTrigger",
					},
				],
			},
		});
	});

	it("maps executeAction notification commands to notificationCommand", async () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		await adapter.handleExecuteAction(socket, {
			actionId: "request_location_update",
			payload: { source: "test" },
		});

		expect(socket.sent).to.deep.equal([
			{
				action: "notificationCommand",
				data: {
					command: "request_location_update",
					payload: { source: "test" },
				},
			},
			{
				action: "executeAction",
				success: true,
				data: {
					actionId: "request_location_update",
				},
			},
		]);
	});

	it("maps executeAction requestSensorRefresh to a refresh request and success ack", async () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		await adapter.handleExecuteAction(socket, {
			actionId: "requestSensorRefresh",
			payload: { source: "test" },
		});

		expect(socket.sent).to.deep.equal([
			{
				action: "requestSensorRefresh",
				data: {
					reason: "executeAction",
					payload: { source: "test" },
				},
			},
			{
				action: "executeAction",
				success: true,
				data: {
					actionId: "requestSensorRefresh",
				},
			},
		]);
	});

	it("acknowledges notificationAck without changing the existing notification payload contract", () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		adapter.handleNotificationAck(socket, {
			payload: {
				aps: {
					alert: {
						title: "Test",
					},
				},
			},
		});

		expect(socket.sent).to.deep.equal([
			{
				action: "notificationAck",
				success: true,
			},
		]);
	});
});
