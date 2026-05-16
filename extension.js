import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

const IgnoreLidToggle = GObject.registerClass(
    class IgnoreLidToggle extends QuickToggle {
        constructor() {
            super({
                title: _('Ignore Lid'),
                iconName: 'weather-tornado-symbolic',
                toggleMode: true,
            });

            this.connect('notify::checked', () => this._updateQuickToggle());
        }

        _updateQuickToggle() {
            if (this.checked) {
                this.title = _('Activate Lid');
            } else {
                this.title = _('Ignore Lid');
            }
        }
    });

const IgnoreLidIndicator = GObject.registerClass(
    class IgnoreLidIndicator extends SystemIndicator {
        constructor() {
            super();

            this._indicator = this._addIndicator();
            this._indicator.iconName = 'weather-tornado-symbolic';

            this.toggle = new IgnoreLidToggle();

            // Link panel icon visibility to toggle state
            this.toggle.bind_property('checked',
                this._indicator, 'visible',
                GObject.BindingFlags.SYNC_CREATE);

            this.quickSettingsItems.push(this.toggle);
        }
    });

export default class QuickSettingsIgnoreLidExtension extends Extension {
    enable() {
        const LogindInterface = `<node>
        <interface name="org.freedesktop.login1.Manager">
            <method name="Inhibit">
                <arg type="s" name="what" direction="in"/>
                <arg type="s" name="who" direction="in"/>
                <arg type="s" name="why" direction="in"/>
                <arg type="s" name="mode" direction="in"/>
                <arg type="h" name="fd" direction="out"/>
            </method>
        </interface>
        </node>`;

        const LogindProxy = Gio.DBusProxy.makeProxyWrapper(LogindInterface);

        this._inhibitorFd = null;
        this._inhibitRequestInProgress = false;
        this._logindProxy = new LogindProxy(
            Gio.DBus.system,
            'org.freedesktop.login1',
            '/org/freedesktop/login1'
        );

        this._indicator = new IgnoreLidIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._toggleSignalId = this._indicator.toggle.connect('notify::checked', () => {
            if (this._indicator.toggle.checked) {
                this.blockLidSwitch();
            } else {
                this.unblockLidSwitch();
            }
        });
    }

    disable() {
        // Restore default lid switch behaviour
        this.unblockLidSwitch();

        // Disconnect the signal while the UI object still exists
        if (this._indicator && this._indicator.toggle && this._toggleSignalId) {
            this._indicator.toggle.disconnect(this._toggleSignalId);
            this._toggleSignalId = null;
        }

        // Destroy UI elements safely
        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }

        // Null out remaining references
        this._logindProxy = null;
    }

    blockLidSwitch() {
        // Prevent multiple simultaneous D-Bus requests
        if (this._inhibitorFd !== null || this._inhibitRequestInProgress) return;

        // Make D-Bus request
        this._inhibitRequestInProgress = true;
        this._logindProxy.InhibitRemote(
            'handle-lid-switch',
            'ignore-lid-extension',
            'User requested temporary ignore of lid switch handle',
            'block',
            (result, error, fdList) => {
                this._inhibitRequestInProgress = false;

                if (error) {
                    console.error(`[ignore-lid-extension] Failed to inhibit handle-lid-switch: ${error.message}`);
                    return;
                }

                // If the extension was disabled during the roundtrip, the user toggled the 
                // switch back OFF, or an FD is already tracked, release the new handle to prevent leaks.
                if (!this._indicator || !this._indicator.toggle || !this._indicator.toggle.checked || this._inhibitorFd !== null) {
                    let [fdHandle] = result;
                    if (fdList) {
                        let dynamicFd = fdList.get(fdHandle);
                        try {
                            GLib.close(dynamicFd);
                        } catch (e) {
                            console.warn(`[ignore-lid-extension] Failed to close dynamic FD: ${e.message}`);
                        }
                    }
                    return;
                }

                let [fdHandle] = result;
                if (fdList) {
                    this._inhibitorFd = fdList.get(fdHandle);
                    console.debug(`[ignore-lid-extension] DEBUG: fdHandle = ${fdHandle}, this._inhibitorFd = ${this._inhibitorFd}`);
                    console.log('[ignore-lid-extension] Lid-switch ignored.');
                }
            }
        );
    }

    unblockLidSwitch() {
        if (this._inhibitorFd !== null) {
            try {
                GLib.close(this._inhibitorFd);
            } catch (e) {
                console.warn(`[ignore-lid-extension] Failed to close inhibitor FD: ${e.message}`);
            }
            this._inhibitorFd = null;
            console.log('[ignore-lid-extension] Lid-switch active. Default behavior restored.');
        }
    }
}