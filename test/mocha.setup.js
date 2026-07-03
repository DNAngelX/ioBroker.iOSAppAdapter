// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (e) => {
	throw e;
});

exports.mochaHooks = {
	beforeAll: async () => {
		const sinonChai = require("sinon-chai");
		const chaiAsPromised = (await import("chai-as-promised")).default;
		const { should, use } = require("chai");

		should();
		use(sinonChai);
		use(chaiAsPromised);
	},
};
