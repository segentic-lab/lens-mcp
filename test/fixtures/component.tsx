import React from 'react';

interface Props {
  title: string;
}

export function Header({ title }: Props): JSX.Element {
  return <div className="header"><h1>{title}</h1></div>;
}

export const Footer = ({ title }: Props) => <footer>{title}</footer>;
