// An imported PNG is the asset ID Metro's bundler gives it, which an Image takes as its source.
declare module "*.png" {
  const asset: number;
  export default asset;
}
