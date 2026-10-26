import DefaultAdmonitionTypes from '@theme-original/Admonition/Types';
import AdmonitionTypeGitHub from './Type/GitHub';

/** The built-in admonition types plus `github`, the standard block for links into the repo. */
const AdmonitionTypes = {
  ...DefaultAdmonitionTypes,
  github: AdmonitionTypeGitHub,
};

export default AdmonitionTypes;
