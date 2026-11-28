const {test}=require('node:test'), assert=require('node:assert/strict');
const vm=require('node:vm'), fs=require('node:fs'),path=require('node:path');
const sandbox={window:{}};vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/js/chat-preferences.js'),'utf8'),sandbox);
const prefs=sandbox.window.RPHubChatPreferences;
test('legacy and malformed display flags default off; explicit preference takes precedence and only booleans enable it',()=>{
    for(const bad of [undefined,null,0,1,'true',{},[]]){const settings={showMemoryCitations:bad};prefs.restore(settings,{});assert.equal(settings.showMemoryCitations,false);}
    const old={temperature:0,model:'model',qualityModel:'model'};prefs.restore(old,{});assert.equal(old.showMemoryCitations,false);assert.equal(old.temperature,0);
    const settings={showMemoryCitations:true,apiKey:'synthetic-secret'};prefs.restore(settings,{showMemoryCitations:false});assert.equal(settings.showMemoryCitations,false);
    prefs.restore(settings,{showMemoryCitations:true});assert.equal(settings.showMemoryCitations,true);assert.equal(prefs.snapshot(settings).showMemoryCitations,true);assert.ok(!JSON.stringify(prefs.snapshot(settings)).includes('synthetic-secret'));
});
