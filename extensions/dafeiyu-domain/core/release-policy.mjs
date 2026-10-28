/** Reviewed release subset. Only a future reviewed code release may open sources. */
export const releasedCategories=Object.freeze({reminder:true,greeting:true,memory:true,weather:false,interest:false});
export const releasedSources=Object.freeze({weather:'release_unavailable',interest:'release_unavailable'});
export function assertReleasedPreference(value){
 if(value?.categories?.weather===true||value?.categories?.interest===true)throw Error('天气与AI自动资讯暂不可用；可保存城市和兴趣，不能开启自动发送。');
}
