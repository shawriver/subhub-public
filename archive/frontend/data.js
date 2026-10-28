export const emptyData = {
  generatedAt:new Date().toISOString(),
  capabilities:{recordManagement:true,subscriptionExport:true,nodeEnrollment:false,credentialSync:false},
  servers:[],nodes:[],nodeHealth:{},nodeTests:{},ruleTemplates:[],members:[],subscriptions:[],profiles:[],tasks:[]
};

export const regionNames = {
  US:"美国",HK:"中国香港",JP:"日本",SG:"新加坡",DE:"德国",GB:"英国",CA:"加拿大",AU:"澳大利亚",KR:"韩国",TW:"中国台湾"
};
