const { app, BrowserWindow, ipcMain: ipc } = require('electron');
const Settings = require('./settings');
const log = require('./utils/logger').create('Windows');
const EventEmitter = require('events').EventEmitter;


class Window extends EventEmitter {
    constructor(mgr, type, opts) {
        super();

        opts = opts || {};

        this._mgr = mgr;
        this._log = log.create(type);
        this.isPrimary = !!opts.primary;
        this.type = type;
        this.isPopup = !!opts.isPopup;
        this.ownerId = opts.ownerId; // the window which creates this new window

        // genericWindow uses 'isAvailable' for reuse
        this.isAvailable = opts.isAvailable || false;

        let electronOptions = {
            title: Settings.appName,
            show: false,
            width: 1100,
            height: 720,
            icon: global.icon,
            titleBarStyle: 'hidden-inset', // hidden-inset: more space
            backgroundColor: '#F6F6F6',
            acceptFirstMouse: true,
            darkTheme: true,
            webPreferences: {
                nodeIntegration: false,
                webaudio: true,
                webgl: false,
                webSecurity: false, // necessary to make routing work on file:// protocol for assets in windows and popups. Not webviews!
                textAreasAreResizable: true,
            },
        };

        electronOptions = _.deepExtend(electronOptions, opts.electronOptions);

        this._log.debug('Creating browser window');

        this.window = new BrowserWindow(electronOptions);

        // set Accept_Language header
        this.session = this.window.webContents.session;
        this.session.setUserAgent(this.session.getUserAgent(), Settings.language);

        this.webContents = this.window.webContents;

        this.webContents.once('did-finish-load', () => {
            this.isContentReady = true;

            this._log.debug(`Content loaded, id: ${this.id}`);

            if (opts.sendData) {
                if (_.isString(opts.sendData)) {
                    this.send(opts.sendData);
                } else if (_.isObject(opts.sendData)) {
                    for (const key in opts.sendData) {
                        if ({}.hasOwnProperty.call(opts.sendData, key)) {
                            this.send(key, opts.sendData[key]);
                        }
                    }
                }
            }

            if (opts.show) {
                this.show();
            }

            this.emit('ready');
        });


        // prevent droping files
        this.webContents.on('will-navigate', (e) => {
            e.preventDefault();
        });


        this.window.once('closed', () => {
            this._log.debug('Closed');

            this.isShown = false;
            this.isClosed = true;
            this.isContentReady = false;

            this.emit('closed');
        });

        this.window.on('close', (e) => {
            // Persist the genericWindow, unless quitting the app
            const continueUsingApp = !global.store.getState().ui.appQuit;
            if (this.type === 'genericWindow' && continueUsingApp) {
                console.info('preventing default onCLOSE!');
                e.preventDefault();
                return this.close();
            }

            this.emit('close', e);
        });

        this.window.on('show', (e) => {
            this.emit('show', e);
        });

        this.window.on('hide', (e) => {
            this.emit('hide', e);
        });

        if (opts.url) {
            this.load(opts.url);
        }
    }

    load(url) {
        if (this.isClosed) {
            return;
        }

        this._log.debug(`Load URL: ${url}`);

        this.window.loadURL(url);
    }

    send() {
        if (this.isClosed || !this.isContentReady) {
            return;
        }

        this._log.trace('Sending data', arguments);

        this.webContents.send.apply(
            this.webContents,
            arguments
        );
    }


    hide() {
        console.info('HIDE!', this.type);
        if (this.isClosed) {
            return;
        }

        this._log.debug('Hide');

        this.window.hide();

        this.isShown = false;
    }


    show() {
        console.info('SHOW!', this.type);
        if (this.isClosed) {
            return;
        }

        this._log.debug('Show');

        this.window.show();

        this.isShown = true;
    }


    close() {
        if (this.isClosed) { return; }
        if (this.type === 'genericWindow') {
            console.info('AVOIDED CLOSING!');
            this.hide();
            this.isAvailable = true;
            return;
        }

        this._log.debug('Close');

        this.window.close();
    }

    reuse(type, options, callback) {
        console.info('REUSE!', type);
        this.isAvailable = false;
        if (options.url) { this.load(options.url); }
        this.window.setSize(options.electronOptions.width, options.electronOptions.height);
        this.window.webContents.once('did-finish-load', () => this.show());
    }
}


class Windows {
    constructor() {
        this._windows = {};
    }


    init() {
        log.info('Creating commonly-used windows');

        this.loading = this.create('loading');

        // The genericWindow gets recycled by popup windows for added performance
        this.genericWindow = this.createPopup('genericWindow', {
            isAvailable: true,
            show: false,
            electronOptions: { isShown: false, }
        });

        this.loading.on('show', () => {
            this.loading.window.center();
        });

        // when a window gets initalized it will send us its id
        ipc.on('backendAction_setWindowId', (event) => {
            const id = event.sender.id;

            log.debug('Set window id', id);

            const bwnd = BrowserWindow.fromWebContents(event.sender);
            const wnd = _.find(this._windows, (w) => {
                return (w.window === bwnd);
            });

            if (wnd) {
                log.trace(`Set window id=${id}, type=${wnd.type}`);

                wnd.id = id;
            }
        });

        store.dispatch({ type: '[MAIN]:WINDOWS:INIT_FINISH' });
    }


    create(type, opts, callback) {
        global.store.dispatch({ type: '[MAIN]:WINDOW:CREATE_START', payload: { type } });

        const options = _.deepExtend(this.getDefaultOptionsForType(type), opts || {});

        const existing = this.getByType(type);

        if (existing && existing.ownerId === options.ownerId) {
            log.debug(`Window ${type} with owner ${options.ownerId} already existing.`);

            return existing;
        }

        const category = options.primary ? 'primary' : 'secondary';

        log.info(`Create ${category} window: ${type}, owner: ${options.ownerId || 'notset'}`);

        const wnd = this._windows[type] = new Window(this, type, options);
        wnd.on('closed', this._onWindowClosed.bind(this, wnd));

        if (callback) {
            wnd.callback = callback;
        }

        global.store.dispatch({ type: '[MAIN]:WINDOW:CREATE_FINISH', payload: { type } });

        return wnd;
    }


    getDefaultOptionsForType(type) {
        const mainWebPreferences = {
            mist: {
                nodeIntegration: true, /* necessary for webviews;
                    require will be removed through preloader */
                preload: `${__dirname}/preloader/mistUI.js`,
                'overlay-fullscreen-video': true,
                'overlay-scrollbars': true,
                experimentalFeatures: true,
            },
            wallet: {
                preload: `${__dirname}/preloader/walletMain.js`,
                'overlay-fullscreen-video': true,
                'overlay-scrollbars': true,
            }
        }

        switch (type) {
            case 'main':
                return {
                    primary: true,
                    electronOptions: {
                        width: Math.max(global.defaultWindow.width, 500),
                        height: Math.max(global.defaultWindow.height, 440),
                        x: global.defaultWindow.x,
                        y: global.defaultWindow.y,
                        webPreferences: mainWebPreferences[global.mode],
                    },
                }
            case 'splash':
                return {
                    primary: true,
                    url: `${global.interfacePopupsUrl}#splashScreen_${global.mode}`,
                    show: true,
                    electronOptions: {
                        width: 400,
                        height: 230,
                        resizable: false,
                        backgroundColor: '#F6F6F6',
                        useContentSize: true,
                        frame: false,
                        webPreferences: {
                            preload: `${__dirname}/preloader/splashScreen.js`,
                        },
                    },
                }
            case 'loading':
                return {
                    show: false,
                    url: `${global.interfacePopupsUrl}#loadingWindow`,
                    electronOptions: {
                        title: '',
                        alwaysOnTop: true,
                        resizable: false,
                        width: 100,
                        height: 80,
                        center: true,
                        frame: false,
                        useContentSize: true,
                        titleBarStyle: '', // hidden-inset: more space
                        skipTaskbar: true,
                    },
                }
            case 'onboardingScreen':
                return {
                    primary: true,
                    electronOptions: {
                        width: 576,
                        height: 442,
                    },
                }
            case 'about':
                return {
                    electronOptions: {
                        width: 420,
                        height: 230,
                        alwaysOnTop: true,
                    },
                }
            case 'remix':
                return {
                    url: 'https://remix.ethereum.org',
                    electronOptions: {
                        width: 1024,
                        height: 720,
                        center: true,
                        frame: true,
                        resizable: true,
                        titleBarStyle: 'default',
                    }
                }
            case 'importAccount':
                return {
                    electronOptions: {
                        width: 600,
                        height: 370,
                        alwaysOnTop: true,
                    },
                }
            case 'requestAccount':
                return {
                    electronOptions: {
                        width: 420,
                        height: 230,
                        alwaysOnTop: true,
                    },
                }
            case 'connectAccount':
                return {
                    electronOptions: {
                        width: 460,
                        height: 520,
                        maximizable: false,
                        minimizable: false,
                        alwaysOnTop: true,
                    },
                }
            case 'sendTransactionConfirmation':
                return {
                    electronOptions: {
                        width: 580,
                        height: 550,
                        alwaysOnTop: true,
                        enableLargerThanScreen: false,
                        resizable: true
                    },
                }
            case 'updateAvailable':
                return {
                    useWeb3: false,
                    electronOptions: {
                        width: 580,
                        height: 250,
                        alwaysOnTop: true,
                        resizable: false,
                        maximizable: false,
                    },
                }
            case 'clientUpdateAvailable':
                return {
                    useWeb3: false,
                    electronOptions: {
                        width: 600,
                        height: 340,
                        alwaysOnTop: false,
                        resizable: false,
                        maximizable: false,
                    },
                }
            default:
                return {}
        }
    }


    createPopup(type, options, callback) {
        const defaultPopupOpts = {
            url: `${global.interfacePopupsUrl}#${type}`,
            show: true,
            ownerId: null,
            useWeb3: true,
            electronOptions: {
                title: '',
                width: 400,
                height: 400,
                resizable: false,
                center: true,
                useContentSize: true,
                titleBarStyle: 'hidden', // hidden-inset: more space
                autoHideMenuBar: true, // TODO: test on windows
                webPreferences: {
                    textAreasAreResizable: false,
                }
            }
        };

        let opts = _.deepExtend(defaultPopupOpts, this.getDefaultOptionsForType(type), options || {});

        // always show on top of main window
        const parent = _.find(this._windows, (w) => {
            return w.type === 'main';
        });

        if (parent) {
            opts.electronOptions.parent = parent.window;
        }


        // mark it as a pop-up window
        opts.isPopup = true;

        if (opts.useWeb3) {
            opts.electronOptions.webPreferences.preload = `${__dirname}/preloader/popupWindows.js`;
        } else {
            opts.electronOptions.webPreferences.preload = `${__dirname}/preloader/popupWindowsNoWeb3.js`;
        }

        // For performance: if genericWindow is available, repurpose it
        const genericWindow = this.getByType('genericWindow');
        if (genericWindow && genericWindow.isAvailable) {
            global.store.dispatch({ type: '[MAIN]:GENERIC_WINDOW:REUSE', payload: { type } });
            return genericWindow.reuse(type, opts, callback);
        }

        if (type !== 'genericWindow') this.loading.show();

        log.info(`Create popup window: ${type}`);

        const wnd = this.create(type, opts, callback);

        wnd.once('ready', () => {
            if (type !== 'genericWindow') { this.loading.hide(); }
        });

        return wnd;
    }


    getByType(type) {
        log.trace('Get by type', type);

        return _.find(this._windows, (w) => {
            return w.type === type;
        });
    }


    getById(id) {
        log.trace('Get by id', id);

        return _.find(this._windows, (w) => {
            return (w.id === id);
        });
    }


    broadcast() {
        const data = arguments;

        log.trace('Broadcast', data);

        _.each(this._windows, (wnd) => {
            wnd.send(...data);
        });
    }


    /**
     * Handle a window being closed.
     *
     * This will remove the window from the internal list.
     *
     * This also checks to see if any primary windows are still visible
     * (even if hidden). If none found then it quits the app.
     *
     * @param {Window} wnd
     */
    _onWindowClosed(wnd) {
        log.debug(`Removing window from list: ${wnd.type}`);

        for (const t in this._windows) {
            if (this._windows[t] === wnd) {
                delete this._windows[t];

                break;
            }
        }

        const anyOpen = _.find(this._windows, (wnd) => {
            return wnd.isPrimary && !wnd.isClosed && wnd.isShown;
        });

        if (!anyOpen) {
            log.info('All primary windows closed/invisible, so quitting app...');

            app.quit();
        }
    }
}


module.exports = new Windows();
