"use strict";

function isDirectIndoorAreaChannel(id, namespace) {
	const prefix = `${namespace}.indoor.areas.`;
	if (!id || !id.startsWith(prefix)) return false;
	const areaId = id.slice(prefix.length);
	return areaId.length > 0 && areaId.includes(".") === false;
}

module.exports = {
	isDirectIndoorAreaChannel,
};
