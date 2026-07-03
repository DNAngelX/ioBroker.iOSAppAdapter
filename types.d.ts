declare global {
    namespace ioBroker {
        interface AdapterConfig {
            username?: string;
            password?: string;
            wsPort?: number;
        }
    }
}

export {};
